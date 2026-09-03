export type ArgumentsType<F> = F extends (...args: infer Arguments) => unknown
  ? Arguments
  : never;

export type Primitive<T> = {
  [k in keyof T]: T[k] extends
    | bigint
    | Date
    | (bigint | null)
    | (Date | null)
    | (bigint | undefined)
    | (Date | undefined)
    ? never
    : T[k] extends object | (object | null) | (object | undefined)
      ? Primitive<T[k]>
      : T[k];
};

export enum CustomFormat {
  UUID = "uuid",
  DATE_TIME = "dateTime",
}

export enum Protocol {
  AMNEZIAWG = "amneziawg",
  AMNEZIAWG2 = "amneziawg2",
  AMNEZIAWG3 = "amneziawg3",
  XRAY = "xray",
}

export interface IAppConfig {
  ENV: "development" | "preproduction" | "production";
  FASTIFY_ROUTES: {
    host: string;
    port: number;
  };
  FASTIFY_API_KEY: string;
  CORS_ORIGINS: string[];
  SERVER_PUBLIC_HOST: string;
  SERVER_ID?: string;
  SERVER_NAME?: string;
  SERVER_REGION?: string;
  SERVER_WEIGHT?: number;
  SERVER_MAX_PEERS?: number;
  PROTOCOLS_ENABLED?: Protocol[];
  // In-panel agent updates. Both are optional and the feature is off without
  // them: no repository means every update request is refused, and no spool
  // means nothing on the host is watching for one.
  NODE_AGENT_UPDATE_REPO?: string;
  NODE_AGENT_UPDATE_SPOOL?: string;
}

export interface IPagination {
  skip: number;
  limit: number;
}
