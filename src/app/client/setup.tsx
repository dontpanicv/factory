import { Projects } from "../../projects/client/projects.tsx";
import { Resources } from "../../sandbox/client/resources.tsx";
import { Secrets } from "../../secrets/client/secrets.tsx";
import { useOverview } from "../../shared/client/overview.ts";
import { Skills } from "../../skills/client/skills.tsx";

/** Setup: what the agents work with. Each tab is the page of one slice. */

const TABS = [
  {
    hint: "Git repositories that sandboxes check out",
    id: "projects",
    title: "Projects",
  },
  {
    hint: "Containers that sandboxes can reach",
    id: "resources",
    title: "Shared resources",
  },
  { hint: "Instructions for one kind of work", id: "skills", title: "Skills" },
  {
    hint: "Credentials for sandboxes and models",
    id: "secrets",
    title: "Secrets",
  },
] as const;

const PANELS = {
  projects: Projects,
  resources: Resources,
  secrets: Secrets,
  skills: Skills,
};

export const SetupPage = (props: { readonly tab: string | null }) => {
  const { data, error, reload } = useOverview();
  if (data === null) {
    return <p class="empty">{error ?? "Loading…"}</p>;
  }
  const tab = TABS.find((one) => one.id === props.tab) ?? TABS[0];
  const Panel = PANELS[tab.id];
  return (
    <div class="fpage stack">
      <div class="page-head page-head--tight">
        <div>
          <span class="eyebrow">Setup</span>
          <h1 class="title title--small">{tab.title}</h1>
        </div>
        <nav aria-label="Setup" class="switch">
          {TABS.map((one) => (
            <a
              aria-current={one.id === tab.id ? "page" : undefined}
              href={`/setup/${one.id}`}
              key={one.id}
              title={one.hint}
            >
              {one.title}
            </a>
          ))}
        </nav>
      </div>
      <Panel key={tab.id} overview={data} reload={reload} />
    </div>
  );
};
