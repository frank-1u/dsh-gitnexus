// GitNexus CLI stand-in that always fails, to prove failures stay silent.
process.stderr.write('gitnexus stub: simulated failure\n')
process.exitCode = 3
