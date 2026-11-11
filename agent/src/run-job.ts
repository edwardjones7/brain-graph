import { loadJobs, runJob } from "./jobs.ts";

// Run one scheduled job now and print what it would send: npm run job -- daily-note
const name = process.argv[2];
const job = (await loadJobs()).find((j) => j.name === name);
if (!job) {
  console.error(`No job "${name}". Jobs: ${(await loadJobs()).map((j) => j.name).join(", ")}`);
  process.exit(1);
}
await runJob(job, async (text) => console.log(text));
