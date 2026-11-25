import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { post, UPLOAD_BYTES_MAX, upload } from "./api.ts";
import { Clock, Close, ListTodo, Paperclip, Tag } from "./icons.tsx";
import { parseNeeds } from "./model.ts";

/**
 * The composer of the Board viewer (`vb inspect`): one outlined box with the textarea and a quiet toolbar.
 * It starts a thread, a task, or a scheduled message, or it replies. Enter sends, Shift+Enter breaks a line,
 * ⌘Enter sends from a list, ⌘B / ⌘I / ⌘E format, lists continue, and every place keeps its draft.
 */

const MAX_HEIGHT = 160;
const TEXT_MAX = 10_000;
const FILES_MAX = 10;
const KIB = 1024;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s(.*)$/;
const NUMBERED = /^\d+\.$/;
const NOT_DIGITS = /\D/g;
const CHANNEL_HASH = /^#/;
const FORMAT: Record<string, string> = { b: "**", e: "`", i: "_" };

/** When a message goes out: in a while or at a time, and again every so often. The board checks it. */
export interface Later {
  readonly at?: string;
  readonly every?: string;
  readonly in?: string;
  readonly times?: number;
}

export interface Sent {
  /** The new thread or task, or null for a reply or a scheduled message. */
  readonly id: string | null;
}

const draftKey = (scope: string) => `board.draft:${scope}`;

/** Drafts live in this tab only; a page without storage still works. */
const readDraft = (scope: string) => {
  try {
    return sessionStorage.getItem(draftKey(scope)) ?? "";
  } catch {
    return "";
  }
};

const writeDraft = (scope: string, text: string) => {
  try {
    if (text === "") {
      sessionStorage.removeItem(draftKey(scope));
    } else {
      sessionStorage.setItem(draftKey(scope), text);
    }
  } catch {
    // No storage: the draft lives only in the box.
  }
};

/** Replaces the selection through the browser, so ⌘Z undoes it. */
const insert = (
  element: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  caret: number
) => {
  element.focus();
  element.setSelectionRange(start, end);
  // execCommand is deprecated, but it is the only edit that the browser's undo keeps.
  if (!document.execCommand("insertText", false, text)) {
    element.setRangeText(text, start, end, "end");
  }
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const fileSize = (bytes: number) =>
  bytes < KIB * KIB
    ? `${Math.max(1, Math.round(bytes / KIB))} KB`
    : `${(bytes / KIB / KIB).toFixed(1)} MB`;

const laterWords = (later: Later) => {
  const parts: string[] = [];
  if (later.in !== undefined) {
    parts.push(`in ${later.in}`);
  }
  if (later.at !== undefined) {
    parts.push(new Date(later.at).toLocaleString());
  }
  if (later.every !== undefined) {
    parts.push(`every ${later.every}`);
  }
  return parts.join(" · ");
};

/** The labels panel: the labels of the message, and a key and value to add. */
const LabelsPanel = (props: {
  readonly known: readonly string[];
  readonly onSet: (key: string, value: string) => void;
}) => {
  const add = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const key = String(data.get("key") ?? "").trim();
    if (key !== "") {
      props.onSet(key, String(data.get("value") ?? "").trim());
      form.reset();
      form.querySelector("input")?.focus();
    }
  };
  const keys = [...new Set(props.known.map((label) => label.split("=")[0]))];
  return (
    <form class="panel" onSubmit={add}>
      <span class="panel__title">labels</span>
      <div class="panel__row">
        <input
          aria-label="Label key"
          autoFocus
          class="input mono"
          data-suggest="composer-label-keys"
          name="key"
          placeholder="key"
          required
        />
        <span class="muted">=</span>
        <input
          aria-label="Label value"
          class="input mono"
          data-suggest="composer-label-values"
          name="value"
          placeholder="value"
        />
        <button class="button button--small button--primary" type="submit">
          Add
        </button>
      </div>
      <datalist id="composer-label-keys">
        {keys.map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>
      <datalist id="composer-label-values">
        {props.known.map((label) => (
          <option key={label} value={label.slice(label.indexOf("=") + 1)} />
        ))}
      </datalist>
    </form>
  );
};

/** The send-later panel: in a while or at a time, and again every so often. */
const LaterPanel = (props: {
  readonly onSet: (later: Later | null) => void;
  readonly value: Later | null;
}) => {
  const set = (event: SubmitEvent) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    const after = field("in");
    const at = field("at");
    const every = field("every");
    const times = Number(field("times").replace(NOT_DIGITS, ""));
    if (after === "" && at === "" && every === "") {
      return;
    }
    props.onSet({
      ...(after === "" ? {} : { in: after }),
      ...(after === "" && at !== "" ? { at: new Date(at).toISOString() } : {}),
      ...(every === "" ? {} : { every }),
      ...(every !== "" && times > 0 ? { times } : {}),
    });
  };
  const clear = () => props.onSet(null);
  return (
    <form class="panel" onSubmit={set}>
      <span class="panel__title">send later</span>
      <div class="panel__row">
        <span class="panel__prefix">in</span>
        <input
          aria-label="Send in"
          autoFocus
          class="input mono"
          data-suggest="composer-later-in"
          defaultValue={props.value?.in ?? ""}
          name="in"
          placeholder="2h"
        />
        <span class="panel__prefix">or at</span>
        <input
          aria-label="Send at"
          class="input mono"
          name="at"
          type="datetime-local"
        />
      </div>
      <div class="panel__row">
        <span class="panel__prefix">every</span>
        <input
          aria-label="Send every"
          class="input mono"
          data-suggest="composer-later-every"
          defaultValue={props.value?.every ?? ""}
          name="every"
          placeholder="never"
        />
        <span class="panel__prefix">times</span>
        <input
          aria-label="Stop after this many sends"
          class="input mono"
          inputMode="numeric"
          name="times"
          placeholder="no limit"
        />
      </div>
      <div class="panel__row panel__row--end">
        {props.value === null ? null : (
          <button
            class="button button--small button--secondary"
            onClick={clear}
            type="button"
          >
            Send now instead
          </button>
        )}
        <button class="button button--small button--primary" type="submit">
          Set
        </button>
      </div>
      <datalist id="composer-later-in">
        <option value="10m" />
        <option value="1h" />
        <option value="3h" />
        <option value="1d" />
      </datalist>
      <datalist id="composer-later-every">
        <option value="1h" />
        <option value="1d" />
        <option value="7d" />
      </datalist>
    </form>
  );
};

type Panel = "labels" | "later";

/** Enter on a list item starts the next one; an empty item ends the list. False: not on a list item. */
const continueList = (element: HTMLTextAreaElement) => {
  const caret = element.selectionStart;
  if (caret !== element.selectionEnd) {
    return false;
  }
  const lineStart = element.value.lastIndexOf("\n", caret - 1) + 1;
  const line = element.value.slice(lineStart, caret);
  if (!LIST_ITEM.test(line)) {
    return false;
  }
  const [, indent = "", marker = "-", rest = ""] = line.match(LIST_ITEM) ?? [];
  if (rest.trim() === "") {
    insert(element, lineStart, caret, "", lineStart);
    return true;
  }
  const next = `\n${indent}${NUMBERED.test(marker) ? `${Number.parseInt(marker, 10) + 1}.` : marker} `;
  insert(element, caret, caret, next, caret + next.length);
  return true;
};

/** ⌘B / ⌘I / ⌘E wrap the selection in bold, italic or code. False: not a format key. */
const formatSelection = (
  element: HTMLTextAreaElement,
  event: KeyboardEvent
) => {
  const format = FORMAT[event.key.toLowerCase()];
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    format === undefined
  ) {
    return false;
  }
  event.preventDefault();
  const { selectionEnd: end, selectionStart: start, value } = element;
  insert(
    element,
    start,
    end,
    `${format}${value.slice(start, end)}${format}`,
    end + format.length * 2
  );
  return true;
};

/** What the composer sends. */
interface Draft {
  readonly channel: string;
  /** Reply to a blocked task, and make it ready again. */
  readonly continueTask: boolean;
  readonly files: readonly File[];
  readonly labels: Readonly<Record<string, string>>;
  readonly later: Later | null;
  readonly needs: readonly string[];
  readonly re: string | undefined;
  readonly task: boolean;
  readonly text: string;
}

/** Sends a draft: the files first, then the task, the schedule, the reply or the thread. */
const submit = async (draft: Draft): Promise<string | null> => {
  const attachments = await Promise.all(draft.files.map(upload));
  const body = {
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(Object.keys(draft.labels).length === 0 ? {} : { labels: draft.labels }),
    text: draft.text,
  };
  if (draft.task) {
    const answer = await post<{ task: { id: string } }>("/tasks", {
      ...body,
      channel: draft.channel,
      ...(draft.needs.length === 0 ? {} : { needs: draft.needs }),
    });
    return answer.task.id;
  }
  const where =
    draft.re === undefined ? { channel: draft.channel } : { re: draft.re };
  if (draft.later !== null) {
    await post("/schedules", { ...body, ...where, ...draft.later });
    return null;
  }
  const answer = await post<{ message: { id: string } }>("/messages", {
    ...body,
    ...where,
  });
  if (draft.re !== undefined && draft.continueTask) {
    await post(`/tasks/${draft.re}/unblock`);
  }
  return draft.re === undefined ? answer.message.id : null;
};

/** A label or a file above or below the text, with its remove button. */
const Chip = (props: {
  readonly children: preact.ComponentChildren;
  readonly muted?: boolean;
  readonly name: string;
  readonly onRemove: (event: MouseEvent) => void;
  readonly value: string;
}) => (
  <span class={props.muted === true ? "tag tag--muted" : "tag"}>
    {props.children}
    <button
      aria-label={`Remove ${props.name}`}
      class="tag__x"
      onClick={props.onRemove}
      type="button"
      value={props.value}
    >
      <Close />
    </button>
  </span>
);

/** A field in the box with a word before it: `# channel`, `needs`. */
const Field = (props: {
  readonly label: string;
  readonly list?: string;
  readonly onInput: (event: Event) => void;
  readonly placeholder: string;
  readonly prefix: string;
  readonly value: string;
  readonly wide?: boolean;
}) => (
  <label
    class={
      props.wide === true
        ? "composer__field composer__field--wide"
        : "composer__field"
    }
  >
    <span class="composer__prefix">{props.prefix}</span>
    <input
      aria-label={props.label}
      autoComplete="off"
      data-suggest={props.list}
      onInput={props.onInput}
      placeholder={props.placeholder}
      value={props.value}
    />
  </label>
);

/** A tool of the footer: an icon, and a word while it is on. */
const Tool = (props: {
  readonly children?: preact.ComponentChildren;
  readonly expanded?: boolean;
  readonly label?: string | null;
  readonly on: boolean;
  readonly onClick: (event: MouseEvent) => void;
  readonly title: string;
  readonly value?: string;
}) => (
  <button
    aria-expanded={props.expanded}
    aria-label={props.title}
    aria-pressed={props.expanded === undefined ? props.on : undefined}
    class={props.on ? "tool tool--on" : "tool"}
    onClick={props.onClick}
    title={props.title}
    type="button"
    value={props.value}
  >
    {props.children}
    {props.label === null || props.label === undefined ? null : (
      <span class="tool__label">{props.label}</span>
    )}
  </button>
);

const sendLabelOf = (busy: boolean, task: boolean, later: Later | null) => {
  if (busy) {
    return "Sending…";
  }
  if (task) {
    return "Start task";
  }
  return later === null ? "Send" : "Schedule";
};

/** The quiet toolbar under the text: attach, labels, task, needs or send later, and send. */
const Footer = (props: {
  readonly asTask: boolean;
  readonly canSend: boolean;
  readonly cont: boolean;
  readonly continues: boolean;
  readonly labels: number;
  readonly later: Later | null;
  readonly needsOpen: boolean;
  readonly onCont: () => void;
  readonly onNeeds: () => void;
  readonly onPanel: (event: MouseEvent) => void;
  readonly onPick: () => void;
  readonly onSend: () => void;
  readonly onTask: () => void;
  readonly panel: Panel | null;
  readonly sendLabel: string;
  readonly task: boolean;
  readonly taskToggle: boolean;
}) => (
  <div class="composer__footer">
    <Tool
      on={false}
      onClick={props.onPick}
      title="Attach files (or paste them)"
    >
      <Paperclip />
    </Tool>
    <Tool
      expanded={props.panel === "labels"}
      label={props.labels > 0 ? String(props.labels) : null}
      on={props.labels > 0}
      onClick={props.onPanel}
      title="Labels for this message"
      value="labels"
    >
      <Tag />
    </Tool>
    {props.taskToggle ? (
      <Tool
        label={props.task ? "task" : null}
        on={props.task}
        onClick={props.onTask}
        title={
          props.task
            ? "Starts as a task: a thread with a state (click for a plain thread)"
            : "Start it as a task"
        }
      >
        <ListTodo />
      </Tool>
    ) : null}
    {props.asTask ? (
      <Tool
        label="needs"
        on={props.needsOpen}
        onClick={props.onNeeds}
        title="The tasks it waits for"
      />
    ) : (
      <Tool
        expanded={props.panel === "later"}
        label={props.later === null ? null : laterWords(props.later)}
        on={props.later !== null}
        onClick={props.onPanel}
        title="Send later"
        value="later"
      >
        <Clock />
      </Tool>
    )}
    {props.continues ? (
      <Tool
        label={props.cont ? "continues the task" : "keeps it held"}
        on={props.cont}
        onClick={props.onCont}
        title="The reply makes the task ready again"
      />
    ) : null}
    <span class="composer__hint">
      enter to send · shift+enter for a new line
    </span>
    <button
      class="button button--primary button--small composer__send"
      disabled={!props.canSend}
      onClick={props.onSend}
      type="button"
    >
      {props.sendLabel}
    </button>
  </div>
);

export const Composer = (props: {
  /** Pick a channel from these; without them the message goes to `channel` or is a reply. */
  readonly channels?: readonly string[];
  /** The channel it posts to, or the one the picker starts on. */
  readonly channel?: string;
  /** A blocked task: the reply continues it, unless the person turns that off. */
  readonly continues?: boolean;
  /** The labels in use, as `key=value`, for suggestions. */
  readonly known: readonly string[];
  readonly onError: (message: string) => void;
  readonly onSent: (sent: Sent) => void;
  readonly placeholder: string;
  /** The thread it replies in. */
  readonly re?: string;
  /** The place of its draft. */
  readonly scope: string;
  /** Whether a new thread can start as a task (`toggle`) or always does (`always`). */
  readonly tasks: "always" | "never" | "toggle";
}) => {
  const [text, setText] = useState(() => readDraft(props.scope));
  const [channel, setChannel] = useState(props.channel ?? "");
  const [task, setTask] = useState(props.tasks === "always");
  const [needsOpen, setNeedsOpen] = useState(false);
  const [needs, setNeeds] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [later, setLater] = useState<Later | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [cont, setCont] = useState(true);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const reply = props.re !== undefined;
  const asTask = props.tasks !== "never" && task && !reply;
  const showNeeds = asTask && (needsOpen || needs.trim() !== "");

  useEffect(() => {
    setText(readDraft(props.scope));
  }, [props.scope]);

  useEffect(() => {
    setChannel(props.channel ?? "");
  }, [props.channel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the box grows with its text.
  useLayoutEffect(() => {
    const element = area.current;
    if (element !== null) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
    }
  }, [text]);

  // A panel closes on a click outside the composer, and on Esc.
  useEffect(() => {
    if (panel === null) {
      return;
    }
    const away = (event: Event) => {
      const pressedEscape =
        event instanceof KeyboardEvent && event.key === "Escape";
      const outside =
        event instanceof MouseEvent &&
        !root.current?.contains(event.target as Node);
      if (pressedEscape || outside) {
        event.stopPropagation();
        setPanel(null);
      }
    };
    addEventListener("mousedown", away);
    addEventListener("keydown", away, true);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", away, true);
    };
  }, [panel]);

  const change = (value: string) => {
    setText(value);
    writeDraft(props.scope, value);
  };

  const attach = (added: readonly File[]) => {
    const tooBig = added.filter((file) => file.size > UPLOAD_BYTES_MAX);
    for (const file of tooBig) {
      props.onError(`${file.name} is over ${UPLOAD_BYTES_MAX / KIB / KIB} MB.`);
    }
    const fitting = added.filter(
      (file) => file.size > 0 && file.size <= UPLOAD_BYTES_MAX
    );
    if (files.length + fitting.length > FILES_MAX) {
      props.onError(`A message carries at most ${FILES_MAX} files.`);
    }
    setFiles([...files, ...fitting].slice(0, FILES_MAX));
    area.current?.focus();
  };

  const target = channel.trim().replace(CHANNEL_HASH, "");
  const hasContent = text.trim() !== "" || files.length > 0;
  const canSend = !busy && hasContent && (reply || target !== "");

  const send = async () => {
    if (!canSend) {
      if (hasContent && !reply && target === "") {
        props.onError("Pick a channel to post in.");
      }
      return;
    }
    setBusy(true);
    try {
      const id = await submit({
        channel: target,
        continueTask: props.continues === true && cont,
        files,
        labels,
        later,
        needs: parseNeeds(needs),
        re: props.re,
        task: asTask,
        text: text.trim(),
      });
      change("");
      setLabels({});
      setFiles([]);
      setNeeds("");
      setNeedsOpen(false);
      setLater(null);
      setTask(props.tasks === "always");
      props.onSent({ id });
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const element = event.currentTarget as HTMLTextAreaElement;
    if (event.key === "Escape") {
      element.blur();
      return;
    }
    if (
      formatSelection(element, event) ||
      event.key !== "Enter" ||
      event.isComposing ||
      event.shiftKey
    ) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    event.preventDefault();
    if (mod || !continueList(element)) {
      send();
    }
  };

  const onInput = (event: Event) =>
    change((event.currentTarget as HTMLTextAreaElement).value);
  const onPaste = (event: ClipboardEvent) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (pasted.length > 0) {
      event.preventDefault();
      attach(pasted);
    }
  };
  const onPick = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    attach([...(input.files ?? [])]);
    input.value = "";
  };
  const onChannel = (event: Event) =>
    setChannel((event.currentTarget as HTMLInputElement).value);
  const onNeeds = (event: Event) =>
    setNeeds((event.currentTarget as HTMLInputElement).value);
  const openPicker = () => picker.current?.click();
  const togglePanel = (event: MouseEvent) => {
    const name = (event.currentTarget as HTMLButtonElement).value as Panel;
    setPanel((current) => (current === name ? null : name));
  };
  const toggleTask = () => setTask((value) => !value);
  const toggleNeeds = () => setNeedsOpen((value) => !value);
  const toggleCont = () => setCont((value) => !value);
  const setLabel = (key: string, value: string) =>
    setLabels((current) => ({ ...current, [key]: value }));
  const unsetLabel = (event: MouseEvent) => {
    const key = (event.currentTarget as HTMLButtonElement).value;
    setLabels((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([name]) => name !== key)
      )
    );
  };
  const removeFile = (event: MouseEvent) => {
    const index = Number((event.currentTarget as HTMLButtonElement).value);
    setFiles((current) => current.filter((_, at) => at !== index));
  };
  const setLaterAndClose = (next: Later | null) => {
    setLater(next);
    setPanel(null);
    area.current?.focus();
  };
  const sendClick = () => {
    send();
  };

  const labelEntries = Object.entries(labels);
  return (
    <div class="composer" ref={root}>
      <div class="composer__box">
        {props.channels === undefined ? null : (
          <Field
            label="Channel"
            list="composer-channels"
            onInput={onChannel}
            placeholder="channel"
            prefix="#"
            value={channel}
          />
        )}
        {props.channels === undefined ? null : (
          <datalist id="composer-channels">
            {props.channels.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        )}
        {showNeeds ? (
          <Field
            label="The tasks this one waits for"
            onInput={onNeeds}
            placeholder="task IDs it waits for: #12 #14"
            prefix="needs"
            value={needs}
            wide
          />
        ) : null}
        {labelEntries.length === 0 ? null : (
          <div class="composer__chips">
            {labelEntries.map(([key, value]) => (
              <Chip key={key} name={key} onRemove={unsetLabel} value={key}>
                {`${key}=${value}`}
              </Chip>
            ))}
          </div>
        )}
        <textarea
          aria-label={props.placeholder}
          class="composer__text"
          data-composer={reply ? "reply" : "main"}
          maxLength={TEXT_MAX}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            asTask
              ? "describe the task… the first line is its title"
              : props.placeholder
          }
          rows={2}
          value={text}
        />
        {files.length === 0 ? null : (
          <div class="composer__chips">
            {files.map((file, index) => (
              <Chip
                key={`${file.name}:${file.size}:${file.lastModified}`}
                muted
                name={file.name}
                onRemove={removeFile}
                value={String(index)}
              >
                {file.name}
                <span class="muted">{fileSize(file.size)}</span>
              </Chip>
            ))}
          </div>
        )}
        <Footer
          asTask={asTask}
          canSend={canSend}
          cont={cont}
          continues={props.continues === true}
          labels={labelEntries.length}
          later={later}
          needsOpen={needsOpen}
          onCont={toggleCont}
          onNeeds={toggleNeeds}
          onPanel={togglePanel}
          onPick={openPicker}
          onSend={sendClick}
          onTask={toggleTask}
          panel={panel}
          sendLabel={sendLabelOf(busy, asTask, later)}
          task={task}
          taskToggle={props.tasks === "toggle" && !reply}
        />
        <input hidden multiple onChange={onPick} ref={picker} type="file" />
        {panel === "labels" ? (
          <LabelsPanel known={props.known} onSet={setLabel} />
        ) : null}
        {panel === "later" ? (
          <LaterPanel onSet={setLaterAndClose} value={later} />
        ) : null}
      </div>
    </div>
  );
};
