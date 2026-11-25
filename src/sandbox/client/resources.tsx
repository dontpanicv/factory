import { post } from "../../shared/client/api.ts";
import {
  Checks,
  Editor,
  NAME_HINT,
  NewButton,
  Text,
  usedBy,
  useEditor,
  values,
} from "../../shared/client/editor.tsx";
import {
  FACTORY,
  type Overview,
  type Resource,
} from "../../shared/client/overview.ts";

/** The Shared resources tab of Setup: containers that sandboxes can reach. */

const RESOURCE_CHIP: Record<string, string> = {
  exited: "failed",
  running: "passed",
  stopped: "skipped",
  unknown: "waiting",
};

export const Resources = (props: {
  readonly overview: Overview;
  readonly reload: () => void;
}) => {
  const { overview } = props;
  const editor = useEditor("resources", props.reload);
  const resource: Resource | undefined = overview.resources.find(
    (one) => one.name === editor.open
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    editor.save({
      command: String(form.get("command") ?? ""),
      container: String(form.get("container") ?? "").trim(),
      description: String(form.get("description") ?? ""),
      env: String(form.get("env") ?? ""),
      image: String(form.get("image") ?? "").trim(),
      name: String(form.get("name")),
      secrets: values(form, "secrets"),
    } as unknown as Resource);
  };
  const power = (event: MouseEvent) => {
    const button = event.currentTarget as HTMLButtonElement;
    editor.write(() =>
      post(`${FACTORY}/resources/${button.name}/${button.value}`)
    );
  };
  return (
    <Editor
      empty="No shared resource yet. A shared resource is a container that runs one time for all sandboxes: PostgreSQL, Elasticsearch, an OIDC server."
      error={editor.error}
      onSubmit={submit}
      open={editor.open}
      rows={
        overview.resources.length === 0 ? null : (
          <>
            {overview.resources.map((one) => (
              <tr key={one.name}>
                <td class="mono nowrap">{one.name}</td>
                <td class="nowrap">
                  <span
                    class={`chip chip--${RESOURCE_CHIP[one.state] ?? "waiting"}`}
                  >
                    {one.state}
                  </span>
                </td>
                <td class="table__fill">
                  <span class="muted small truncate">
                    {`${one.container === "" ? one.image : `container ${one.container}`} · ${usedBy(overview, "resources", one.name)}`}
                  </span>
                </td>
                <td class="nowrap row-actions">
                  <button
                    class="button button--small button--secondary"
                    name={one.name}
                    onClick={power}
                    type="button"
                    value={one.state === "running" ? "stop" : "start"}
                  >
                    {one.state === "running" ? "Stop" : "Start"}
                  </button>
                  <button
                    class="button button--small button--secondary"
                    onClick={editor.pick}
                    type="button"
                    value={one.name}
                  >
                    Edit
                  </button>
                  <button
                    class="button button--small button--secondary"
                    onClick={editor.remove}
                    type="button"
                    value={one.name}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            <NewButton
              onPick={editor.pick}
              open={editor.open}
              title="shared resource"
            />
          </>
        )
      }
      title="shared resource"
    >
      <Text
        hint={`Also its host name in the sandboxes that can reach it. Use ${NAME_HINT}.`}
        label="Name"
        mono
        name="name"
        placeholder="postgres"
        readOnly={resource !== undefined}
        required
        value={resource?.name ?? ""}
      />
      <Text
        hint="Factory starts a container from this image."
        label="Container image"
        mono
        name="image"
        placeholder="postgres:17"
        value={resource?.image ?? ""}
      />
      <Text
        hint="Or the name of a container that runs already. Factory does not start or stop it: it only lets the sandboxes reach it."
        label="Existing container"
        mono
        name="container"
        placeholder="my-postgres"
        value={resource?.container ?? ""}
      />
      <Text
        hint="Agents read this: say what it is for and how to connect."
        label="Description"
        name="description"
        placeholder="The test database. User postgres, port 5432."
        value={resource?.description ?? ""}
      />
      <Text
        area
        label="Environment, KEY=value lines"
        name="env"
        placeholder="POSTGRES_HOST_AUTH_METHOD=trust"
        short
        value={resource?.env ?? ""}
      />
      <div class="field">
        <span class="label">Secrets, as environment variables</span>
        <Checks
          chosen={resource?.secrets ?? []}
          empty="No secret yet."
          name="secrets"
          options={overview.secrets}
        />
      </div>
      <Text
        hint="Empty: the command of the image."
        label="Command"
        mono
        name="command"
        value={resource?.command ?? ""}
      />
    </Editor>
  );
};
