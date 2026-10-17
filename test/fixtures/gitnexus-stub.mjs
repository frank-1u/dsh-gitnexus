// Minimal GitNexus CLI stand-in for the adapter end-to-end tests.
// The adapter reads graph context from stderr, so the stub writes it there.
const [command = '', ...rest] = process.argv.slice(2)

if (command === 'augment') {
  process.stderr.write('GitNexus Augment (stub)\n[GitNexus] stub context for ' + rest.join(' ') + '\n')
} else {
  process.stderr.write('gitnexus stub: unhandled command ' + command + '\n')
  process.exitCode = 1
}
