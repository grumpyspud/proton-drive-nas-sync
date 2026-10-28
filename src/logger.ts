export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

export const logger: Logger = {
    debug: (m) => console.debug(`[pdn:debug] ${m}`),
    info: (m) => console.log(`[pdn:info] ${m}`),
    warn: (m) => console.warn(`[pdn:warn] ${m}`),
    error: (m, e) => console.error(`[pdn:error] ${m}`, e ?? ''),
};

// Minimal Telemetry-satisfying object for the Drive SDK (telemetry is optional).
export const telemetry = {
    getLogger: (_name: string): Logger => logger,
    recordMetric: (_event: unknown): void => {},
};
