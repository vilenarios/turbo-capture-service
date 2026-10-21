// Derive seccomp/chrome.json from Docker's default seccomp profile.
//
// Docker's default profile only allows clone() with namespace flags,
// unshare() and setns() to containers holding CAP_SYS_ADMIN, and chroot() to
// containers holding CAP_SYS_CHROOT. Chrome's namespace sandbox needs exactly
// these to create an unprivileged user namespace and chroot its renderers
// into an empty directory. This adds one rule allowing them, unconditionally,
// and leaves everything else as in the default profile, so the container can
// still run with cap_drop: ALL.
//
// Usage: node scripts/make-seccomp.mjs <docker-default.json> > seccomp/chrome.json
// Source used: https://github.com/moby/profiles/blob/main/seccomp/default.json
import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'));
profile.syscalls.push({
  names: ['clone', 'unshare', 'setns', 'chroot'],
  action: 'SCMP_ACT_ALLOW',
  comment: 'turbo-capture: Chrome namespace sandbox (user/pid/net namespaces + chroot)',
});
process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
