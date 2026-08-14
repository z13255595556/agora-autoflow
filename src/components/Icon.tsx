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
  vars: <path d="M6 2.8c-1.6.6-2.2 2-2 3.4.2 1-.3 1.5-1.2 1.8.9.3 1.4.8 1.2 1.8-.2 1.4.4 2.8 2 3.4M10 2.8c1.6.6 2.2 2 2 3.4-.2 1 .3 1.5 1.2 1.8-.9.3-1.4.8-1.2 1.8.2 1.4-.4 2.8-2 3.4" />,
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
