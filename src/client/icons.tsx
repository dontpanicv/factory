/** The composer's tool icons: Lucide's shapes (ISC licence), square, in the current colour. */

const Icon = (props: { readonly children: preact.ComponentChildren }) => (
  <svg
    aria-hidden="true"
    fill="none"
    height="14"
    stroke="currentColor"
    // Preact writes SVG attributes as they are named here, so the stroke is set as CSS.
    style={{ strokeLinecap: "square", strokeWidth: 2 }}
    viewBox="0 0 24 24"
    width="14"
  >
    {props.children}
  </svg>
);

export const Paperclip = () => (
  <Icon>
    <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
  </Icon>
);

export const Tag = () => (
  <Icon>
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    <rect fill="currentColor" height="2" width="2" x="6.5" y="6.5" />
  </Icon>
);

export const ListTodo = () => (
  <Icon>
    <rect height="6" width="6" x="3" y="5" />
    <path d="m3 17 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />
  </Icon>
);

export const Clock = () => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </Icon>
);

export const Close = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="11"
    stroke="currentColor"
    style={{ strokeWidth: 2 }}
    viewBox="0 0 24 24"
    width="11"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const ChevronDown = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const Check = () => (
  <Icon>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);
