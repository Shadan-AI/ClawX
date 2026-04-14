/**
 * 傻蛋AI | openme^ClawX 品牌 Logo 组件
 * logoSrc: 传入图片 URL（用 import 导入）
 */
export function BrandLogo({ className = '', logoSrc }: { className?: string; logoSrc?: string }) {
  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`}>
      {/* 傻蛋AI 图标 */}
      <div className="flex items-center gap-1.5">
        {logoSrc ? (
          <img src={logoSrc} alt="傻蛋AI" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          /* fallback: 渐变圆圈 */
          <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="sdai-fb" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="50%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#f472b6" />
              </linearGradient>
            </defs>
            <circle cx="16" cy="16" r="15" fill="none" stroke="url(#sdai-fb)" strokeWidth="2.5" />
            <circle cx="16" cy="16" r="10" fill="white" />
          </svg>
        )}
        <span className="text-base font-bold tracking-wide">傻蛋AI</span>
      </div>

      {/* 分隔线 */}
      <span className="h-5 w-px bg-current opacity-25" />

      {/* openme + ClawX 上标 */}
      <span className="relative text-base font-bold tracking-wide">
        OpenMe
        <sup className="absolute -top-1.5 -right-7 text-[10px] font-bold text-red-500 leading-none">
          Claw
        </sup>
      </span>
    </div>
  );
}
