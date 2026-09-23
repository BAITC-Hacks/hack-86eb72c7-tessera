import 'server-only';

export class ProjectDataError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ProjectDataError';
    this.status = status;
    this.code = code;
  }
}
