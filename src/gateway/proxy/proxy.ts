import type { Request, Response } from 'express';

/** Phase 3: forwards allowed requests to the dummy downstream backend. */
export async function proxyToBackend(_req: Request, _res: Response): Promise<void> {
  void _req;
  void _res;
  throw new Error('proxy: not implemented yet (Phase 3)');
}
