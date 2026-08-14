/**
 * 界面图标。
 *
 * 之前这些位置混用了字形和 emoji（`⤢` `⧉` `🗑`）—— emoji 在 macOS 上是彩色的、
 * 在别的系统上又换一副样子，和旁边的单色字形放一起怎么调都不协调，而且字形
 * 的基线各家字体都不一样，按钮里永远差半个像素。统一换成 16px 的线条图标：
 * 全部 currentColor，跟着按钮的 hover 色走。
 *
 * 节点自己的图标（⏰ 📅 ✉）不在这里 —— 那是注册表里的数据，由各服务上报。
 */

const PATHS: Record<string, JSX.Element> = {
  back: <path d="M10 12.5 5.5 8 10 3.5" />,
  play: <path d="M4.5 3.2v9.6l8-4.8z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  expand: <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 3.2A1.7 1.7 0 0 0 8.9 2.5H4.2a1.7 1.7 0 0 0-1.7 1.7v4.7c0 .7.4 1.3 1 1.6" />
    </>
  ),
  trash: <path d="M2.8 4.4h10.4M6.4 4.4V3.2c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.2M4.2 4.4l.5 8c0 .6.5 1.1 1.1 1.1h4.4c.6 0 1.1-.5 1.1-1.1l.5-8" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  undo: <path d="M6.2 4.2 2.8 7.1l3.4 2.8M3.1 7.1h5.5c2.6 0 4.3 1.4 4.3 4.1" />,
  redo: <path d="m9.8 4.2 3.4 2.9-3.4 2.8M12.9 7.1H7.4c-2.6 0-4.3 1.4-4.3 4.1" />,
  more: (
    <>
      <circle cx="3.6" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  fit: <path d="M2.5 5.8v-2a1.3 1.3 0 0 1 1.3-1.3h2M13.5 5.8v-2a1.3 1.3 0 0 0-1.3-1.3h-2M2.5 10.2v2a1.3 1.3 0 0 0 1.3 1.3h2M13.5 10.2v2a1.3 1.3 0 0 1-1.3 1.3h-2" />,
  layout: <path d="M2.5 8h3.5M10 4.2h3.5M10 11.8h3.5M6 8h1.4c.7 0 1.2-.5 1.4-1.1l.4-1.5c.2-.7.7-1.2 1.4-1.2M6 8h1.4c.7 0 1.2.5 1.4 1.1l.4 1.5c.2.7.7 1.2 1.4 1.2" />,
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="M10.4 10.4 13.5 13.5" />
    </>
  ),
  pointer: <path d="M3.4 2.3 12 8.6l-3.8.8 2 3.7-2 1.1-2-3.8-2.5 2.8Z" />,
  hand: <path d="M5.2 7V4.3c0-.6.4-1 .9-1s.9.4.9 1V7M7 6V3.5c0-.6.4-1 .9-1s.9.4.9 1V6M8.8 6V4c0-.6.4-1 .9-1s.9.4.9 1v3.5M10.6 6.5V5.3c0-.6.4-1 .9-1s.9.4.9 1v4c0 2.7-1.6 4.2-4.2 4.2-1.8 0-2.8-.7-3.8-2.2L2.4 9.6c-.3-.5-.1-1.1.4-1.4.4-.2.9-.1 1.2.2l1.2 1.2" />,
  note: <path d="M3 2.5h10v7.2l-3.8 3.8H3ZM9.2 13.5V9.7H13" />,
  settings: <path d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5ZM6.8 2.5h2.4l.4 1.4c.3.1.6.3.9.5l1.4-.4 1.2 2.1-1 1c0 .3.1.6 0 .9l1 1-1.2 2.1-1.4-.4-.9.5-.4 1.4H6.8l-.4-1.4-.9-.5-1.4.4L2.9 9l1-1a4 4 0 0 1 0-.9l-1-1L4.1 4l1.4.4.9-.5Z" />,
  import: <path d="M8 2.5v7M5.2 6.8 8 9.6l2.8-2.8M3 10.5v2.2c0 .4.4.8.8.8h8.4c.4 0 .8-.4.8-.8v-2.2" />,
  vars: <path d="M6 2.8c-1.6.6-2.2 2-2 3.4.2 1-.3 1.5-1.2 1.8.9.3 1.4.8 1.2 1.8-.2 1.4.4 2.8 2 3.4M10 2.8c1.6.6 2.2 2 2 3.4-.2 1 .3 1.5 1.2 1.8-.9.3-1.4.8-1.2 1.8.2 1.4-.4 2.8-2 3.4" />,
  eye: (
    <>
      <path d="M1.8 8s2.2-3.5 6.2-3.5S14.2 8 14.2 8 12 11.5 8 11.5 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.7" />
    </>
  ),
  eyeOff: <path d="m2.2 2.2 11.6 11.6M6.4 4.7A7 7 0 0 1 8 4.5c4 0 6.2 3.5 6.2 3.5a10 10 0 0 1-1.8 2.1M9.5 11.3c-.5.1-1 .2-1.5.2C4 11.5 1.8 8 1.8 8a10.4 10.4 0 0 1 2.1-2.3M6.8 6.8A1.7 1.7 0 0 0 9.2 9.2" />,
}

export type IconName = keyof typeof PATHS

export default function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'play' || name === 'stop' ? (
        <g fill="currentColor" stroke="none">
          {PATHS[name]}
        </g>
      ) : (
        PATHS[name]
      )}
    </svg>
  )
}
