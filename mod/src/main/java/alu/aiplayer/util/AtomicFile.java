package alu.aiplayer.util;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

/**
 * Writes a file so that a crash at any moment, even of the whole machine, leaves either the old or the new
 * contents and never an empty or half-written file. A plain write followed by a rename is not enough: the rename can
 * reach the disk before the data does, and after a power cut or a killed virtual machine the file is then empty.
 */
public final class AtomicFile {

    private AtomicFile() {}

    /** Where {@link #write} keeps the previous contents when asked to. */
    public static File backupOf(File file) {
        return new File(file.getPath() + ".bak");
    }

    /**
     * Writes the bytes to a temporary file, forces them to disk and moves the file over the target in one step. With
     * keepBackup the previous contents, which are already on disk, first become {@link #backupOf the backup}, so a
     * reader that finds the target missing or unreadable has the last state but one to fall back on.
     */
    public static void write(File target, byte[] bytes, boolean keepBackup) throws IOException {
        File dir = target.getAbsoluteFile()
            .getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File tmp = new File(target.getPath() + ".tmp");
        try (FileChannel ch = FileChannel.open(
            tmp.toPath(),
            StandardOpenOption.CREATE,
            StandardOpenOption.TRUNCATE_EXISTING,
            StandardOpenOption.WRITE)) {
            ByteBuffer buf = ByteBuffer.wrap(bytes);
            while (buf.hasRemaining()) ch.write(buf);
            ch.force(true);
        }
        // An empty target is what a crash leaves behind; it must not replace a good backup.
        if (keepBackup && target.isFile() && target.length() > 0) move(target.toPath(), backupOf(target).toPath());
        move(tmp.toPath(), target.toPath());
        syncDir(dir);
    }

    private static void move(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** Makes the renames themselves durable. Some systems (Windows) cannot open a directory; there this is skipped. */
    private static void syncDir(File dir) {
        if (dir == null) return;
        try (FileChannel ch = FileChannel.open(dir.toPath(), StandardOpenOption.READ)) {
            ch.force(true);
        } catch (IOException | RuntimeException ignored) {
            // Nothing more can be done; the data itself is already on disk.
        }
    }
}
