// Example script. Start it with:
//   POST /api/v1/scripts/example/run   { "args": ["Alice"] }
//
// - Arguments from the request arrive in process.argv.slice(2); the run id is in process.env.RUN_ID.
// - Everything printed to stdout / stderr is saved on the run.
// - Exit code 0 means success; anything else (or an uncaught error) marks the run as failed.

const [name = 'World'] = process.argv.slice(2);

console.log(`Hello, ${name}! This is run ${process.env.RUN_ID}.`);

await new Promise((resolve) => setTimeout(resolve, 1000));

console.log(`Finished greeting ${name}`);
