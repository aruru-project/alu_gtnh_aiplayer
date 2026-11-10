package alu.aiplayer.bridge;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.Tags;
import alu.aiplayer.util.J;

/**
 * Line-delimited JSON over local TCP (see docs/PROTOCOL.md). Sockets are served by their own threads; every
 * request is executed on the server thread from {@link #pump()}, so handlers may touch the world freely.
 */
public final class BridgeServer {

    public interface Handler {

        JsonElement handle(JsonObject params) throws Exception;
    }

    private static final int MAX_LINE_BYTES = 4 * 1024 * 1024;
    private static final int EVENT_BUFFER = 1000;
    private static final int MAX_REQUESTS_PER_TICK = 200;
    private static final int MAX_QUEUED_LINES = 5000;

    private final String host;
    private final int port;
    private final String token;
    private final String epoch;
    private final Map<String, Handler> methods = new HashMap<>();
    private final List<Conn> conns = new CopyOnWriteArrayList<>();
    private final ConcurrentLinkedQueue<Incoming> inbox = new ConcurrentLinkedQueue<>();
    private final ArrayDeque<BufferedEvent> events = new ArrayDeque<>();
    private long seq;
    private volatile ServerSocket serverSocket;

    public BridgeServer(String host, int port, File tokenFile) {
        this.host = host;
        this.port = port;
        this.token = loadOrCreateToken(tokenFile);
        byte[] raw = new byte[9];
        new SecureRandom().nextBytes(raw);
        this.epoch = hex(raw);
    }

    public void register(String method, Handler handler) {
        methods.put(method, handler);
    }

    public String epoch() {
        return epoch;
    }

    public void start() {
        try {
            ServerSocket ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(InetAddress.getByName(host), port));
            serverSocket = ss;
        } catch (IOException e) {
            AiPlayerMod.LOG.error("Bridge cannot listen on {}:{}; the AI player cannot be controlled", host, port, e);
            return;
        }
        Thread t = new Thread(this::acceptLoop, "aiplayer-bridge-accept");
        t.setDaemon(true);
        t.start();
        AiPlayerMod.LOG.info("Bridge listening on {}:{}", host, port);
    }

    public void stop() {
        ServerSocket ss = serverSocket;
        serverSocket = null;
        if (ss != null) {
            try {
                ss.close();
            } catch (IOException ignored) {}
        }
        for (Conn c : conns) c.close();
        conns.clear();
    }

    private void acceptLoop() {
        ServerSocket ss = serverSocket;
        while (ss != null && !ss.isClosed()) {
            try {
                Socket s = ss.accept();
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                Conn c = new Conn(s);
                conns.add(c);
                c.start();
            } catch (IOException e) {
                if (serverSocket != null) AiPlayerMod.LOG.warn("Bridge accept failed", e);
                return;
            }
        }
    }

    /** Runs queued requests. Call once per server tick on the server thread. */
    public void pump() {
        for (int n = 0; n < MAX_REQUESTS_PER_TICK; n++) {
            Incoming in = inbox.poll();
            if (in == null) return;
            handle(in);
        }
    }

    /** Broadcasts an event to every authenticated client and keeps it for replay. Server thread only. */
    public void emit(String event, JsonObject data) {
        JsonObject o = new JsonObject();
        o.addProperty("event", event);
        o.addProperty("seq", ++seq);
        o.addProperty("time", System.currentTimeMillis());
        o.add("data", data == null ? new JsonObject() : data);
        String line = o.toString();
        events.addLast(new BufferedEvent(seq, line));
        while (events.size() > EVENT_BUFFER) events.removeFirst();
        for (Conn c : conns) {
            if (c.authed) c.send(line);
        }
    }

    private void handle(Incoming in) {
        Conn conn = in.conn;
        JsonElement id = null;
        try {
            JsonObject req = J.parseObject(in.line);
            id = req.get("id");
            String method = J.str(req, "method", "");
            JsonObject params = J.object(req, "params");
            if (params == null) params = new JsonObject();
            if (method.equals("hello")) {
                hello(conn, id, params);
                return;
            }
            if (!conn.authed) {
                conn.send(error(id, "unauthorized", "the first request must be hello with a valid token"));
                conn.closeAfterFlush();
                return;
            }
            Handler h = methods.get(method);
            if (h == null) {
                conn.send(error(id, "unknown_method", "unknown method: " + method));
                return;
            }
            JsonElement result = h.handle(params);
            JsonObject res = new JsonObject();
            res.add("id", id);
            res.addProperty("ok", true);
            res.add("result", result == null ? new JsonObject() : result);
            conn.send(res.toString());
        } catch (RpcException e) {
            conn.send(error(id, e.code, e.getMessage()));
        } catch (IllegalArgumentException | IllegalStateException | ClassCastException
            | com.google.gson.JsonParseException e) {
                conn.send(error(id, "bad_request", String.valueOf(e.getMessage())));
            } catch (Throwable t) {
                AiPlayerMod.LOG.error("Bridge request failed: {}", abbreviate(in.line), t);
                conn.send(error(id, "internal", t.getClass().getSimpleName() + ": " + t.getMessage()));
            }
    }

    private void hello(Conn conn, JsonElement id, JsonObject params) {
        String given = J.str(params, "token", "");
        if (!MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8))) {
            conn.send(error(id, "unauthorized", "bad token"));
            conn.closeAfterFlush();
            return;
        }
        conn.authed = true;
        conn.client = J.str(params, "client", "?");
        JsonObject result = new JsonObject();
        result.addProperty("protocol", 1);
        result.addProperty("modVersion", Tags.VERSION);
        result.addProperty("mcVersion", "1.7.10");
        result.addProperty("serverEpoch", epoch);
        result.addProperty("seq", seq);
        JsonObject res = new JsonObject();
        res.add("id", id);
        res.addProperty("ok", true);
        res.add("result", result);
        conn.send(res.toString());
        if (epoch.equals(J.str(params, "serverEpoch", "")) && J.has(params, "lastSeq")) {
            long last = J.l(params, "lastSeq", seq);
            for (BufferedEvent e : events) {
                if (e.seq > last) conn.send(e.line);
            }
        }
        AiPlayerMod.LOG.info("Bridge client connected: {}", conn.client);
    }

    private static String error(JsonElement id, String code, String message) {
        JsonObject err = new JsonObject();
        err.addProperty("code", code);
        err.addProperty("message", message);
        JsonObject res = new JsonObject();
        res.add("id", id);
        res.addProperty("ok", false);
        res.add("error", err);
        return res.toString();
    }

    private static String abbreviate(String s) {
        return s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }

    private static String loadOrCreateToken(File file) {
        try {
            if (file.isFile()) {
                String t = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim();
                if (t.length() >= 16) return t;
            }
            byte[] raw = new byte[24];
            new SecureRandom().nextBytes(raw);
            String t = hex(raw);
            file.getParentFile()
                .mkdirs();
            Files.write(file.toPath(), (t + "\n").getBytes(StandardCharsets.UTF_8));
            try {
                Files.setPosixFilePermissions(
                    file.toPath(),
                    EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            } catch (UnsupportedOperationException ignored) {
                // Non-POSIX file systems keep their default permissions.
            }
            return t;
        } catch (IOException e) {
            throw new IllegalStateException("cannot create bridge token file " + file, e);
        }
    }

    private static String hex(byte[] raw) {
        StringBuilder sb = new StringBuilder(raw.length * 2);
        for (byte b : raw) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static final class BufferedEvent {

        final long seq;
        final String line;

        BufferedEvent(long seq, String line) {
            this.seq = seq;
            this.line = line;
        }
    }

    private static final class Incoming {

        final Conn conn;
        final String line;

        Incoming(Conn conn, String line) {
            this.conn = conn;
            this.line = line;
        }
    }

    private final class Conn {

        private static final String CLOSE_MARK = "\u0000close";
        final Socket socket;
        final LinkedBlockingQueue<String> out = new LinkedBlockingQueue<>();
        volatile boolean authed;
        volatile boolean closed;
        volatile String client = "?";

        Conn(Socket socket) {
            this.socket = socket;
        }

        void start() {
            Thread r = new Thread(this::readLoop, "aiplayer-bridge-read");
            r.setDaemon(true);
            r.start();
            Thread w = new Thread(this::writeLoop, "aiplayer-bridge-write");
            w.setDaemon(true);
            w.start();
        }

        void send(String line) {
            if (closed) return;
            if (out.size() > MAX_QUEUED_LINES) {
                AiPlayerMod.LOG.warn("Bridge client {} is not reading; dropping it", client);
                close();
                return;
            }
            out.add(line);
        }

        void closeAfterFlush() {
            out.add(CLOSE_MARK);
        }

        void close() {
            if (closed) return;
            closed = true;
            conns.remove(this);
            out.add(CLOSE_MARK);
            try {
                socket.close();
            } catch (IOException ignored) {}
        }

        private void readLoop() {
            try {
                InputStream in = socket.getInputStream();
                ByteArrayOutputStream line = new ByteArrayOutputStream(256);
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    for (int i = 0; i < n; i++) {
                        byte b = buf[i];
                        if (b == '\n') {
                            String text = new String(line.toByteArray(), StandardCharsets.UTF_8).trim();
                            line.reset();
                            if (!text.isEmpty()) inbox.add(new Incoming(this, text));
                        } else {
                            if (line.size() >= MAX_LINE_BYTES) throw new IOException("line too long");
                            line.write(b);
                        }
                    }
                }
            } catch (IOException e) {
                // Closed by either side; nothing to report.
            } finally {
                close();
            }
        }

        private void writeLoop() {
            try {
                OutputStream os = socket.getOutputStream();
                while (true) {
                    String line = out.take();
                    if (line == CLOSE_MARK) break;
                    os.write(line.getBytes(StandardCharsets.UTF_8));
                    os.write('\n');
                    if (out.isEmpty()) os.flush();
                }
                os.flush();
            } catch (IOException | InterruptedException e) {
                // Fall through to close.
            } finally {
                close();
            }
        }
    }
}
