'use strict';

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Only intentional, public errors are returned to the browser. Never log request bodies or tokens. */
function route(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            const message = error instanceof HttpError ? error.message : '插件內部錯誤；請檢查安裝與伺服器設定。';
            if (!res.headersSent) res.status(status).json({ error: message });
            else res.end();
            if (status >= 500 && !res.destroyed) {
                console.error(`[sillytavern-custom-text2img] HTTP ${status}`);
            }
        }
    };
}

module.exports = { HttpError, route };
