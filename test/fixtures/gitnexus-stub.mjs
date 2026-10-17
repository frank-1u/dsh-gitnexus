// Minimal GitNexus CLI stand-in for the adapter end-to-end tests.
// The adapter reads graph context from stderr, so the stub writes it there.
const [command = '', ...rest] = process.argv.slice(2)

if (command === 'augment') {
  // Report the directory GitNexus actually ran in: the end-to-end seam asserts
  // that the adapter resolved the Augment Root, never its internals.
  process.stderr.write('GitNexus Augment (stub)\n[GitNexus] stub context for ' + rest.join(' ') + ' cwd=' + process.cwd() + '\n')
} else {
  process.stderr.write('gitnexus stub: unhandled command ' + command + '\n')
  process.exitCode = 1
}
