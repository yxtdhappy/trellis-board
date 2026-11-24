export function normalizeBasePath(value: unknown): string
export function readBasePath(doc?: Pick<Document, 'querySelector'> | null): string
export function withBasePath(pathname: string, basePath?: string): string
export function stripBasePath(pathname: string, basePath?: string): string
export function appOriginWithBase(loc?: Pick<Location, 'origin'> | null, basePath?: string): string
