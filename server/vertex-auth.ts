import { GoogleAuth } from 'google-auth-library';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './security.js';

export type VertexTokenProvider = (config: Config) => Promise<string>;
export function readVertexCredentials(path: string, root = process.cwd()) {
  try {
    const requested = resolve(root, path);
    const full = realpathSync(requested);
    for (const folder of ['public', 'dist', 'src']) {
      const directory = resolve(root, folder);
      const realDirectory = (() => {
        try {
          return realpathSync(directory);
        } catch {
          return directory;
        }
      })();
      if (
        requested === directory ||
        requested.startsWith(directory + sep) ||
        full === realDirectory ||
        full.startsWith(realDirectory + sep)
      )
        throw new Error();
    }
    // Only service-account keys; never honor credential-supplied external URLs or executables.
    const value = z
      .object({
        type: z.literal('service_account'),
        client_email: z.email(),
        private_key: z.string().min(100),
        private_key_id: z.string().optional(),
        universe_domain: z.literal('googleapis.com').optional(),
      })
      .parse(JSON.parse(readFileSync(full, 'utf8')));
    return {
      type: value.type,
      client_email: value.client_email,
      private_key: value.private_key,
      private_key_id: value.private_key_id,
    };
  } catch {
    throw new AppError(
      503,
      'อ่าน Service Account JSON ไม่ได้ ตรวจชนิดไฟล์ สิทธิ์อ่าน และเก็บไว้นอก public/dist/src',
    );
  }
}
const clients = new Map<string, GoogleAuth>();
export const vertexAccessToken: VertexTokenProvider = async (config) => {
  const key = JSON.stringify([config.vertexProject, config.vertexCredentials]);
  try {
    let auth = clients.get(key);
    if (!auth) {
      auth = new GoogleAuth({
        projectId: config.vertexProject,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...(config.vertexCredentials
          ? { credentials: readVertexCredentials(config.vertexCredentials) }
          : {}),
        clientOptions: { transporterOptions: { timeout: 8000, retry: false } },
      });
      if (clients.size >= 8) clients.clear();
      clients.set(key, auth);
    }
    const token = await auth.getAccessToken();
    if (!token) throw new Error();
    return token;
  } catch {
    throw new AppError(
      503,
      'ยืนยันสิทธิ์ Vertex AI ไม่สำเร็จ ตรวจ Service Account/ADC และสิทธิ์ Vertex AI User',
    );
  }
};
export const vertexConfigured = (config: Config) =>
  Boolean(!config.demo && config.vertexProject && config.vertexModel);
export const embeddingIdentity = (config: Config) =>
  `vertex:${config.embeddingModel}:768:retrieval-v1`;
