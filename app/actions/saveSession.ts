"use server"
import { prisma } from '@/lib/prisma'

// Define valid stage types
type Stage = 
  | "1_Baseline_Relaxed"
  | "2_Cognitive_Warmup"
  | "3_Focused_Task"
  | "4_Post_Task_Rest";

// Stage instructions mapping
const STAGE_INSTRUCTIONS: Record<string, string> = {
  "1_Baseline_Relaxed": "Close your eyes, relax, and listen to calming music or nature sounds.",
  "2_Cognitive_Warmup": "Do simple tasks like basic arithmetic or identify colors. Nothing too hard.",
  "3_Focused_Task": "Perform a focused task (e.g., mental math, reading, or debugging). Stay concentrated.",
  "4_Post_Task_Rest": "Return to a relaxed state. Breathe deeply, eyes closed, no task.",
};

export async function saveSessionToDatabase({ participantName, startedAt, notes, stages }: {
  participantName: string,
  startedAt: number,
  notes?: string,
  stages: Array<{
    stageName: string,
    stageOrder: number,
    durationSeconds: number,
    eegData: Array<{
      value: number,
      timestamp: number,
      stage: Stage | string | null
    }>,
  }>
}) {
  try {
    console.log('[saveSessionToDatabase] Payload:', { participantName, startedAt, notes, stages });
    
    // Log specific information about EEG data for debugging
    if (stages.length > 0 && stages[0].eegData.length > 0) {
      const sampleData = stages[0].eegData.slice(0, 3);
      console.log('[saveSessionToDatabase] Sample EEG data:', JSON.stringify(sampleData, null, 2));
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
    
    // Create EegStageData for each stage with properly formatted eegData and instructions
    for (const stage of stages) {
      // Process eegData to ensure all entries have the correct stage value
      const processedEegData = stage.eegData.map(datum => ({
        ...datum,
        stage: datum.stage || stage.stageName // Ensure stage is set if null
      }));
      
      // Get instructions for this stage
      const instructions = STAGE_INSTRUCTIONS[stage.stageName] || `Instructions for ${stage.stageName}`;
      
      await prisma.eegStageData.create({
        data: {
          sessionId: session.id,
          stageName: stage.stageName,
          stageOrder: stage.stageOrder,
          durationSeconds: stage.durationSeconds,
          instructions: instructions,
          eegData: processedEegData,
        },
      });
    }
    
    console.log('[saveSessionToDatabase] Session saved:', session.id);
    return { success: true, sessionId: session.id };
  } catch (error) {
    console.error('[saveSessionToDatabase] Error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
} 