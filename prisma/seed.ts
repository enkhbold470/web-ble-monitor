import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // Create a default AuthUser (example)
  await prisma.authUser.upsert({
    where: { email: 'admin@neurofocus.com' },
    update: {},
    create: {
      email: 'admin@neurofocus.com',
      password: 'adminpassword', // In production, hash this!
      name: 'Admin',
      role: 'admin',
    },
  })

  // Create a default Participant (example)
  await prisma.participant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Test Participant',
      authUserId: null,
      consentGiven: true,
      consentAt: new Date(),
    },
  })

  // Create a default Session (example)
  await prisma.session.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      participantId: '00000000-0000-0000-0000-000000000001',
      startedAt: new Date(),
      notes: 'Initial session for testing',
    },
  })

  // Create a default EegStageData (example)
  await prisma.eegStageData.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      sessionId: '00000000-0000-0000-0000-000000000001',
      stageName: 'Baseline',
      stageOrder: 1,
      durationSeconds: 60,
      instructions: 'Relax and sit still.',
      eegData: {},
    },
  })

  // Create a default EegData (example)
  await prisma.eegData.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      userId: '00000000-0000-0000-0000-000000000001',
      eegData: {},
      betaPower: 0.5,
      lowBetaWarning: false,
    },
  })

  console.log('Database seeded successfully!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  }) 