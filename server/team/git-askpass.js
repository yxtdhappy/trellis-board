const prompt = process.argv.slice(2).join(" ");
const username = process.env.TRELLIS_GIT_USERNAME || "";
const secret = process.env.TRELLIS_GIT_SECRET || "";
process.stdout.write(`${/username/i.test(prompt) ? username : secret}\n`);
