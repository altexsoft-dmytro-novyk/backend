import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Prisma 7 moved seed config here (out of package.json's `prisma.seed`).
    // tsx, not ts-node: the generated client's relative imports carry
    // explicit `.js` extensions (NodeNext-style) resolving to `.ts` sources
    // — ts-node's CJS require() can't follow that, tsx's resolver can.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
