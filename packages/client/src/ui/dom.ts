// Tiny DOM helper: h('div.cls#id', { attrs, on: { click } }, children…)
type Child = Node | string | number | null | undefined | false | Child[];
type Props = { [k: string]: unknown; on?: Record<string, (e: any) => void>; style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K | string, props?: Props | Child, ...children: Child[]): HTMLElement {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag as string);
  const el = document.createElement(m?.[1] || 'div');
  if (m?.[2]) for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props as Child); props = undefined; }
  if (props) {
    for (const [k, v] of Object.entries(props as Props)) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
      else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v !== undefined && v !== null) {
        if (k in el && k !== 'list' && k !== 'form') (el as any)[k] = v; else el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

/** Escape text, then turn **bold** into <strong>. Used for tutorial hints. */
export function richText(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export const rc = (i: number, w: number) => `(${Math.floor(i / w)}, ${i % w})`;
