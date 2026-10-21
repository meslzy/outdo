// Stands in for `ssh <target> <command>` in tests: echoes what it was asked to run.
const [target, command] = process.argv.slice(2);
console.log(`target=${target}`);
console.log(`command=${command}`);
