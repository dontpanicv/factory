import { Effect, Schema } from "effect";

/** The parts of a definition's schema that the slices share. */

/** A text setting. A definition without it gets `fallback`. */
export const text = (fallback = "") =>
  Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));

/** A list of names: of projects, of secrets. */
export const names = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed<readonly string[]>([]))
);

/** A name is also a host name, a directory and a part of a container name. */
export const Name = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/)
);
