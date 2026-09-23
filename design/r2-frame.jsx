// R2Frame — picks the device frame for the MaybeSitter R2 prototype. Scaffolding only (not product UI).
function R2Frame({ platform = 'ios', dark = false, children, keyboard = false, height = 874 }) {
  if (platform === 'android') return <AndroidDevice dark={dark} keyboard={keyboard}>{children}</AndroidDevice>;
  if (platform === 'bare') return <div style={{ width: 402, height, position: 'relative', overflow: 'hidden', background: dark ? '#101416' : '#F5F7F8', borderRadius: 24 }}>{children}</div>;
  return <IOSDevice dark={dark} keyboard={keyboard}>{children}</IOSDevice>;
}
window.R2Frame = R2Frame;
