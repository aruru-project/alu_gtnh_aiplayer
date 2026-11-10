package alu.aiplayer.bridge;

/** A request failure that is reported to the bridge client with a protocol error code. */
public final class RpcException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public final String code;

    public RpcException(String code, String message) {
        super(message);
        this.code = code;
    }

    public static RpcException badRequest(String message) {
        return new RpcException("bad_request", message);
    }

    public static RpcException notFound(String message) {
        return new RpcException("not_found", message);
    }

    public static RpcException offline(String message) {
        return new RpcException("offline", message);
    }

    public static RpcException denied(String message) {
        return new RpcException("denied", message);
    }

    public static RpcException tooLarge(String message) {
        return new RpcException("too_large", message);
    }
}
