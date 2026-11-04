// Control API: the only thing perf-framework, chaos-runner, CI pipelines and people talk to.
import express from 'express';
import { z } from 'zod';
import { HttpError, describeProfile } from './virtualizer.js';

const applyBody = z.object({ profile: z.string().min(1) }).strict();
const startBody = z
  .object({ service: z.string(), targetUrl: z.string(), urlPathPattern: z.string().optional() })
  .strict();
const stopBody = z.object({ save: z.boolean().optional(), fit: z.boolean().optional() }).strict();
const fitBody = z
  .object({
    name: z.string(),
    samplesMs: z.array(z.number()),
    description: z.string().optional(),
    save: z.boolean().optional(),
    overwrite: z.boolean().optional()
  })
  .strict();

function parseBody(schema, body, hint) {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, `Invalid body: ${hint}`);
  return parsed.data;
}

export function createApp(virtualizer, recorder) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const route = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res))
      .then((data) => res.json(data))
      .catch(next);

  app.get(
    '/api/health',
    route(async () => ({
      status: 'ok',
      wiremock: (await virtualizer.wiremock.isUp()) ? 'up' : 'down',
      wiremockUrl: virtualizer.wiremock.baseUrl
    }))
  );

  app.get(
    '/api/profiles',
    route(() => virtualizer.listProfiles())
  );
  app.get(
    '/api/profiles/:name',
    route((req) => describeProfile(virtualizer.getProfile(req.params.name)))
  );
  app.post(
    '/api/profiles/reload',
    route(() => virtualizer.reloadProfiles())
  );
  app.post(
    '/api/profiles/fit',
    route((req) =>
      recorder.fitFromSamples(
        parseBody(fitBody, req.body, '{"name", "samplesMs": [..], "save"?, "overwrite"?, "description"?}')
      )
    )
  );

  app.get(
    '/api/recordings',
    route(() => recorder.status())
  );
  app.post(
    '/api/recordings/start',
    route((req) => recorder.start(parseBody(startBody, req.body, '{"service", "targetUrl", "urlPathPattern"?}')))
  );
  app.post(
    '/api/recordings/stop',
    route((req) => recorder.stop(parseBody(stopBody, req.body, '{"save"?: boolean, "fit"?: boolean}')))
  );

  app.get(
    '/api/services',
    route(() => virtualizer.listServices())
  );

  app.post(
    '/api/services/:service/profile',
    route((req) => {
      const parsed = applyBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new HttpError(400, 'Body must be {"profile": "<name>"}');
      return virtualizer.applyProfile(req.params.service, parsed.data.profile);
    })
  );

  app.post(
    '/api/services/:service/reset',
    route((req) => virtualizer.resetService(req.params.service))
  );

  app.get(
    '/api/services/:service/stats',
    route((req) => {
      const limit = Number.parseInt(req.query.limit ?? '1000', 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new HttpError(400, 'limit must be 1-100000');
      return virtualizer.serviceStats(req.params.service, limit);
    })
  );

  app.get(
    '/api/unmatched',
    route(() => virtualizer.unmatched())
  );
  app.post(
    '/api/stubs/reload',
    route(() => virtualizer.loadStubs())
  );

  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

  app.use((err, req, res, next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return app;
}
