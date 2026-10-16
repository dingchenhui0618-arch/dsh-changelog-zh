// Client styles for dsh-changelog-zh.
//
// Colours are built with color-mix() against currentColor and low-alpha accents,
// so the panel inherits the host theme instead of fighting it: no hard-coded
// background or text colour anywhere, which is what keeps it legible under both
// light and dark themes without shipping two palettes.

module.exports = [
  '.cz-root{display:flex;flex-direction:column;gap:12px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5}',
  '.cz-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
  '.cz-title{font-size:15px;font-weight:600}',
  '.cz-sub{opacity:.6;font-size:12px}',
  '.cz-spacer{flex:1}',
  '.cz-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;align-items:end}',
  '.cz-field{display:flex;flex-direction:column;gap:4px}',
  '.cz-field label{font-size:11px;opacity:.65}',
  '.cz-input{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;min-width:0}',
  '.cz-input::placeholder{opacity:.45}',
  '.cz-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.cz-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer}',
  '.cz-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.cz-btn:disabled{opacity:.45;cursor:default}',
  '.cz-btn.cz-primary{border-color:color-mix(in srgb,currentColor 45%,transparent);font-weight:600}',
  '.cz-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px}',
  '.cz-stat{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:8px 10px}',
  '.cz-stat b{display:block;font-size:18px;font-variant-numeric:tabular-nums;line-height:1.2}',
  '.cz-stat span{opacity:.6;font-size:11px}',
  '.cz-stat.cz-good b{color:#16a34a}',
  '.cz-stat.cz-warn b{color:#d97706}',
  '.cz-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:10px 12px}',
  '.cz-card h4{margin:0 0 6px;font-size:12px;font-weight:600;opacity:.75}',
  '.cz-tabs{display:flex;gap:6px;align-items:center}',
  '.cz-tab{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer}',
  '.cz-tab.cz-on{background:color-mix(in srgb,currentColor 12%,transparent);border-color:color-mix(in srgb,currentColor 40%,transparent);font-weight:600}',
  '.cz-out{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:10px 12px;background:color-mix(in srgb,currentColor 3%,transparent)}',
  '.cz-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;margin:0;max-height:46vh;overflow:auto}',
  '.cz-list{display:flex;flex-direction:column;gap:5px;margin:0;padding-left:18px;font-size:12px}',
  '.cz-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}',
  '.cz-note{font-size:12px;opacity:.75}',
  '.cz-empty{opacity:.55;font-size:12px;padding:10px 0}',
  '.cz-err{border:1px solid color-mix(in srgb,#dc2626 50%,transparent);background:color-mix(in srgb,#dc2626 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}',
  '.cz-ok{border:1px solid color-mix(in srgb,#16a34a 45%,transparent);background:color-mix(in srgb,#16a34a 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}',
].join('')
