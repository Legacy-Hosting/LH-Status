import { z } from "zod";

const fqdnSchema = z.string().trim().toLowerCase().regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
);

export const componentTargetSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().trim().min(2).max(80),
  url: z.string().url(),
  connectHostname: fqdnSchema.optional(),
  primary: z.boolean().optional(),
  datacenter: z.string().trim().min(2).max(80).optional(),
  service: z.string().trim().min(2).max(80).optional(),
  number: z.string().trim().regex(/^[A-Za-z0-9-]{1,12}$/).optional(),
  order: z.number().int().min(0).max(999).optional(),
});

const remoteComponentTargetSchema = componentTargetSchema.extend({
  connectHostname: fqdnSchema,
  primary: z.boolean(),
  datacenter: z.string().trim().min(2).max(80),
  service: z.string().trim().min(2).max(80),
  number: z.string().trim().regex(/^[A-Za-z0-9-]{1,12}$/),
  order: z.number().int().min(0).max(999),
}).superRefine((component, context) => {
  const url = new URL(component.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "Public component URLs must be credential-free HTTPS",
    });
  }
});

export type ComponentTarget = z.infer<typeof componentTargetSchema>;
export type ComponentReader = () => Promise<ComponentTarget[]>;

export function validatedComponentTargets(parsed: unknown, remote = false) {
  const schema = remote ? remoteComponentTargetSchema : componentTargetSchema;
  const components = z.array(schema).min(1).max(100).parse(parsed);
  if (new Set(components.map((component) => component.key)).size !== components.length) {
    throw new Error("Status component keys must be unique");
  }
  return components;
}

export function createRemoteComponentReader(options: {
  url: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
}): ComponentReader {
  const source = new URL(options.url);
  if (source.protocol !== "https:" || source.username || source.password || source.hash) {
    throw new Error("Remote component configuration must use credential-free HTTPS");
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return async () => {
    const response = await fetchImplementation(source, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Remote status components returned ${response.status}`);
    return validatedComponentTargets(await response.json(), true);
  };
}
