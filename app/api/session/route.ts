import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { participantName, startedAt, notes, stages } = body;
    if (!participantName || !startedAt || !Array.isArray(stages)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Find or create participant
    let participant = await prisma.participant.findFirst({ where: { name: participantName } });
    if (!participant) {
      participant = await prisma.participant.create({ data: { name: participantName } });
    }

    // Create session
    const session = await prisma.session.create({
      data: {
        participantId: participant.id,
        startedAt: new Date(startedAt),
        notes: notes || '',
      },
    });

    // Create EegStageData for each stage
    for (const stage of stages) {
      await prisma.eegStageData.create({
        data: {
          sessionId: session.id,
          stageName: stage.stageName,
          stageOrder: stage.stageOrder,
          durationSeconds: stage.durationSeconds,
          eegData: stage.eegData,
        },
      });
    }

    return NextResponse.json({ success: true, sessionId: session.id });
  } catch (error) {
    console.error('Error saving session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 