import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Option, type Redacted } from "effect";

export interface AuthSettings {
  readonly accessGroup: string;
  readonly googleClientId: string;
  readonly googleClientSecret: Redacted.Redacted;
  readonly secret: Redacted.Redacted;
  readonly serviceAccountKeyFile: string;
  readonly workspaceDomain: string;
}

export interface SettingsShape {
  /** Google sign-in. None means local mode: no sign-in, and only requests from this computer. */
  readonly auth: Option.Option<AuthSettings>;
  /** The public origin of the UI, without a trailing slash. */
  readonly baseUrl: string;
  readonly dataDir: string;
  /** The user name that the UI shows in local mode. */
  readonly localUser: string;
  readonly port: number;
}

export class Settings extends Context.Service<Settings, SettingsShape>()(
  "factory/Settings"
) {}

const DEFAULT_PORT = 4310;
const TRAILING_SLASH = /\/+$/;

/** An empty value counts as not set. */
const optionalString = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.filter((value) => value.trim() !== ""))
  );

const settingsConfig = Config.all({
  dataDir: Config.String("FACTORY_DATA_DIR").pipe(Config.withDefault("data")),
  factoryUrl: optionalString("FACTORY_URL"),
  googleClientId: optionalString("GOOGLE_CLIENT_ID"),
  port: Config.Port("PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  portlessUrl: optionalString("PORTLESS_URL"),
});

/** Google sign-in needs all of these when GOOGLE_CLIENT_ID is set. */
const googleConfig = (googleClientId: string) =>
  Config.all({
    accessGroup: Config.String("FACTORY_ACCESS_GROUP"),
    googleClientId: Config.succeed(googleClientId),
    googleClientSecret: Config.Redacted("GOOGLE_CLIENT_SECRET"),
    secret: Config.Redacted("BETTER_AUTH_SECRET"),
    serviceAccountKeyFile: Config.String("GOOGLE_SA_KEY_FILE"),
    workspaceDomain: Config.String("GOOGLE_WORKSPACE_DOMAIN"),
  });

export const SettingsLive = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const raw = yield* settingsConfig;
    return {
      auth: Option.isSome(raw.googleClientId)
        ? Option.some(yield* googleConfig(raw.googleClientId.value))
        : Option.none(),
      baseUrl: Option.getOrElse(
        Option.orElse(raw.factoryUrl, () => raw.portlessUrl),
        () => `http://localhost:${raw.port}`
      ).replace(TRAILING_SLASH, ""),
      dataDir: resolve(raw.dataDir),
      localUser: `${userInfo().username} (this computer)`,
      port: raw.port,
    };
  })
);

export const databaseFile = (settings: SettingsShape) =>
  join(settings.dataDir, "factory.sqlite");
