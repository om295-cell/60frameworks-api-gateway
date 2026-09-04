import app from './app.js';

// Default export for Vercel Serverless / Express builder
export default app;

// If started directly via `node index.js`
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'));

if (isDirectRun || process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 60Frameworks API Gateway running at http://localhost:${PORT}`);
    console.log(`⚖️  Active Load-Balanced Backends:`);
    console.log(`   [1] https://60frameworks-back1.vercel.app`);
    console.log(`   [2] https://60frameworks-back2.vercel.app`);
    console.log(`   [3] https://60frameworks-back3.vercel.app`);
    console.log(`======================================================\n`);
  });
}
