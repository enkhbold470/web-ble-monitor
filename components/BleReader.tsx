"use client";
import React, { useState, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { processEegData } from "@/lib/eegUtils";
import { saveSessionToDatabase } from "@/app/actions/saveSession";

const SERVICE_UUID = "0338ff7c-6251-4029-a5d5-24e4fa856c8d";
const CHARACTERISTIC_UUID = "ad615f2b-cc93-4155-9e4d-f5f32cb9a2d7";

const SESSION_DURATION = 15; // 15 seconds for debug

type BleState = "idle" | "scanning" | "connecting" | "connected" | "error";
type Stage = 
  | "1_Baseline_Relaxed"
  | "2_Cognitive_Warmup"
  | "3_Focused_Task"
  | "4_Post_Task_Rest";

interface EegDatum {
  value: number;
  timestamp: number;
  stage: Stage | null;
}

interface StageData {
  stageName: Stage;
  stageOrder: number;
  startTime: number;
  endTime: number;
  eegData: EegDatum[];
}

export default function BleReader() {
  const [bleState, setBleState] = useState<BleState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [participant, setParticipant] = useState("");
  const [participantSaved, setParticipantSaved] = useState(false);
  const [data, setData] = useState<EegDatum[]>([]);
  const [currentStage, setCurrentStage] = useState<Stage | null>(null);
  const [stageHistory, setStageHistory] = useState<StageData[]>([]);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [timer, setTimer] = useState(SESSION_DURATION);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const stageStartTimeRef = useRef<number | null>(null);
  const stageOrderRef = useRef<number>(1);
  const characteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [initialStage, setInitialStage] = useState<Stage | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [awaitingContinue, setAwaitingContinue] = useState(false);
  const stageOrderList: Stage[] = [
    "1_Baseline_Relaxed",
    "2_Cognitive_Warmup",
    "3_Focused_Task",
    "4_Post_Task_Rest"
  ];

  // Start session timer
  const startSession = () => {
    console.log("Starting session with initial stage:", initialStage);
    setSessionActive(true);
    setSessionEnded(false);
    setTimer(SESSION_DURATION);
    stageOrderRef.current = 1;
    stageStartTimeRef.current = Date.now();
    setStageHistory([]);
    setData([]);
    setCurrentStage(initialStage); // Use selected initial stage
    console.log("Current stage set to:", initialStage);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          endSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // End session
  const endSession = () => {
    console.log("Ending session, current stage:", currentStage);
    setSessionActive(false);
    setSessionEnded(true);
    setIsStreaming(false);
    setBleState("idle");
    if (timerRef.current) clearInterval(timerRef.current);
    
    // Save last stage if active
    if (currentStage && stageStartTimeRef.current) {
      const stageEnd = Date.now();
      const stageData = data.filter(d => d.timestamp >= stageStartTimeRef.current!);
      console.log(`Adding stage ${currentStage} with ${stageData.length} data points`);
      
      setStageHistory(prev => {
        const newHistory = [
          ...prev,
          {
            stageName: currentStage,
            stageOrder: stageOrderRef.current,
            startTime: stageStartTimeRef.current!,
            endTime: stageEnd,
            eegData: stageData,
          }
        ];
        console.log("Updated stage history:", newHistory);
        return newHistory;
      });
    } else {
      console.warn("No current stage or start time when ending session");
      // Create a dummy stage if none exists, just to ensure we have something to save
      if (initialStage && data.length > 0) {
        console.log("Creating fallback stage with initial stage:", initialStage);
        setStageHistory([{
          stageName: initialStage,
          stageOrder: 1,
          startTime: Date.now() - 10000, // 10 seconds ago
          endTime: Date.now(),
          eegData: data.slice(-50).map(d => ({
            ...d,
            stage: initialStage // Ensure stage is set properly
          })),
        }]);
      } else if (data.length > 0) {
        // If no initialStage was set, default to first stage type
        console.log("Creating default fallback stage");
        setStageHistory([{
          stageName: "1_Baseline_Relaxed",
          stageOrder: 1,
          startTime: Date.now() - 10000, // 10 seconds ago
          endTime: Date.now(),
          eegData: data.slice(-50).map(d => ({
            ...d,
            stage: "1_Baseline_Relaxed" // Set default stage
          })),
        }]);
      }
    }
    
    // Debug check after a short delay to see if stageHistory was updated
    setTimeout(() => {
      console.log("Stage history after timeout:", stageHistory);
    }, 500);
  };

  // Switch stage
  const handleStage = (stage: Stage) => {
    if (!sessionActive) return;
    if (currentStage && stageStartTimeRef.current) {
      // Save previous stage
      const stageEnd = Date.now();
      const stageData = data.filter(d => d.timestamp >= stageStartTimeRef.current!);
      setStageHistory((prev) => [
        ...prev,
        {
          stageName: currentStage,
          stageOrder: stageOrderRef.current,
          startTime: stageStartTimeRef.current!,
          endTime: stageEnd,
          eegData: stageData,
        },
      ]);
      stageOrderRef.current += 1;
    }
    setCurrentStage(stage);
    stageStartTimeRef.current = Date.now();
  };

  // Connect to BLE device
  const connect = async () => {
    setError(null);
    setBleState("scanning");
    setDeviceName(null);
    setData([]);
    setIsStreaming(false);
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      setDeviceName(device.name || device.id);
      setBleState("connecting");
      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      characteristicRef.current = characteristic;
      setBleState("connected");
      setIsStreaming(true);
      characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", handleNotification);
      device.addEventListener("gattserverdisconnected", () => {
        setBleState("idle");
        setIsStreaming(false);
      });
    } catch (err: any) {
      setError(err.message || String(err));
      setBleState("error");
    }
  };

  // Handle incoming BLE notifications
  const handleNotification = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const decoder = new TextDecoder("utf-8");
    const str = decoder.decode(value.buffer);
    const num = parseInt(str, 10);
    if (!isNaN(num)) {
      // Make sure the stage is properly attached to each data point
      setData((prev) => [
        ...prev.slice(-99),
        { 
          value: num, 
          timestamp: Date.now(), 
          stage: currentStage 
        },
      ]);
    }
  };

  // Disconnect
  const disconnect = async () => {
    setIsStreaming(false);
    setBleState("idle");
    setDeviceName(null);
    setData([]);
    if (characteristicRef.current) {
      try {
        characteristicRef.current.removeEventListener("characteristicvaluechanged", handleNotification);
        const device = characteristicRef.current.service.device;
        if (device.gatt?.connected) {
          await device.gatt.disconnect();
        }
      } catch {}
    }
  };

  // Prevent accidental refresh/close while streaming
  React.useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isStreaming) {
        e.preventDefault();
        e.returnValue = "Streaming is active. Are you sure you want to leave?";
        return e.returnValue;
      }
    };
    if (isStreaming) {
      window.addEventListener("beforeunload", handleBeforeUnload);
    } else {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    }
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isStreaming]);

  // Save participant name before starting
  const handleSaveParticipant = (e: React.FormEvent) => {
    e.preventDefault();
    if (participant.trim()) setParticipantSaved(true);
  };

  async function saveSessionToBackend() {
    console.log("Save button clicked, stage history:", stageHistory);
    
    // Allow saving even with empty stages for debugging
    if (!participant) {
      console.error("No participant name");
      setSaveError("No participant name");
      setSaveStatus('error');
      return;
    }
    
    setSaveStatus('saving');
    setSaveError(null);
    
    // Use dummy data if no real stages
    const stages = stageHistory.length > 0 ? 
      stageHistory.map(stage => {
        // Make sure each eegData point has the correct stage
        const eegDataWithStage = stage.eegData.map(d => ({
          ...d,
          stage: d.stage || stage.stageName // Use point's stage if available, otherwise use the stage name
        }));
        
        return {
          stageName: stage.stageName,
          stageOrder: stage.stageOrder,
          durationSeconds: Math.round((stage.endTime - stage.startTime) / 1000),
          eegData: eegDataWithStage,
        };
      }) : 
      [{
        stageName: initialStage || "1_Baseline_Relaxed",
        stageOrder: 1,
        durationSeconds: 10,
        eegData: data.slice(-50).map(d => ({
          ...d,
          stage: initialStage || "1_Baseline_Relaxed" // Ensure stage is set here too
        })) || [],
      }];
    
    const startedAt = stageHistory.length > 0 ? 
      stageHistory[0].startTime : 
      Date.now() - 10000; // 10 seconds ago
    
    const body = {
      participantName: participant,
      startedAt,
      notes: "",
      stages,
    };
    
    console.log('[saveSessionToBackend] Sending payload:', body);
    
    try {
      // Try using server action directly first
      try {
        console.log("Trying server action...");
        const result = await saveSessionToDatabase(body);
        console.log('[saveSessionToBackend] Server action response:', result);
        if (result.success) {
          setSaveStatus('success');
          // If not last stage, prompt to continue
          if (currentStage && stageOrderRef.current < stageOrderList.length) {
            setAwaitingContinue(true);
          }
          return;
        }
      } catch (serverActionError) {
        console.error("Server action failed, falling back to API route:", serverActionError);
      }
      
      // Fall back to API route if server action fails
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      console.log('[saveSessionToBackend] API response:', result);
      if (result.success) {
        setSaveStatus('success');
        if (currentStage && stageOrderRef.current < stageOrderList.length) {
          setAwaitingContinue(true);
        }
      } else {
        setSaveStatus('error');
        setSaveError(result.error || 'Unknown error');
      }
    } catch (err: any) {
      setSaveStatus('error');
      setSaveError(err.message || String(err));
      console.error('[saveSessionToBackend] Network error:', err);
    }
  }

  // Handler for Continue button
  function handleContinueStage() {
    setAwaitingContinue(false);
    // Advance to next stage
    const nextOrder = stageOrderRef.current + 1;
    if (nextOrder <= stageOrderList.length) {
      setCurrentStage(stageOrderList[nextOrder - 1]);
      stageOrderRef.current = nextOrder;
      stageStartTimeRef.current = Date.now();
      setSessionActive(true);
      setSessionEnded(false);
      setTimer(SESSION_DURATION);
      // Optionally clear data or keep accumulating
      setData([]);
    }
  }

  // Handler for Finish button
  function handleFinishSession() {
    setAwaitingContinue(false);
    setSessionActive(false);
    setSessionEnded(true);
  }

  // UI
  return (
    <div className="max-w-3xl mx-auto p-6 rounded-xl shadow mt-8">
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        Bluetooth EEG Reader
        <span className={`inline-block w-2 h-2 rounded-full ml-2 ${bleState === "connected" ? "status-connected" : bleState === "error" ? "status-error" : "status-idle"}`}></span>
      </h2>
      {!participantSaved ? (
        <form onSubmit={handleSaveParticipant} className="mb-4 flex gap-2">
          <input
            type="text"
            placeholder="Enter participant name"
            value={participant}
            onChange={e => setParticipant(e.target.value)}
            className="flex-1 px-3 py-2 rounded border border-input"
            required
          />
          <Button type="submit" className="px-4 py-2 rounded transition">Save</Button>
        </form>
      ) : null}
      {participantSaved && bleState === "idle" && !sessionActive && !sessionEnded && (
        <Button onClick={connect} className="mb-4 px-4 py-2 rounded transition">Connect to EEG Device</Button>
      )}
      {participantSaved && bleState === "connected" && !sessionActive && !sessionEnded && (
        <>
      
          <Button
            onClick={startSession}
            className="mb-4 px-4 py-2 rounded hover:opacity-90 transition"
            disabled={!initialStage}
          >
            Start Session
          </Button>
        </>
      )}
      {sessionActive && (
        <div className="mb-4 flex items-center gap-4">
          <span className="font-medium">Time Left:</span>
          <span className="text-lg font-mono">{Math.floor(timer/60).toString().padStart(2,'0')}:{(timer%60).toString().padStart(2,'0')}</span>
        </div>
      )}
      {participantSaved && (
        <div className="mb-4 flex items-center gap-4">
          <span className="font-medium">Participant:</span>
          <span className="font-mono">{participant}</span>
        </div>
      )}
      {sessionActive && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button onClick={() => handleStage("1_Baseline_Relaxed")}
            className={`px-3 py-1 rounded ${currentStage === "1_Baseline_Relaxed" ? "btn-stage-baseline" : "btn-stage-inactive"}`}>
            1: Baseline
          </Button>
          <Button onClick={() => handleStage("2_Cognitive_Warmup")}
            className={`px-3 py-1 rounded ${currentStage === "2_Cognitive_Warmup" ? "btn-stage-warmup" : "btn-stage-inactive"}`}>
            2: Warmup
          </Button>
          <Button onClick={() => handleStage("3_Focused_Task")}
            className={`px-3 py-1 rounded ${currentStage === "3_Focused_Task" ? "btn-stage-focus" : "btn-stage-inactive"}`}>
            3: Focus
          </Button>
          <Button onClick={() => handleStage("4_Post_Task_Rest")}
            className={`px-3 py-1 rounded ${currentStage === "4_Post_Task_Rest" ? "btn-stage-rest" : "btn-stage-inactive"}`}>
            4: Rest
          </Button>
        </div>
      )}
      {bleState === "scanning" && <p>Scanning for device...</p>}
      {bleState === "connecting" && <p>Connecting...</p>}
      {bleState === "connected" && (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium">Connected to:</span>
            <span className="font-mono">{deviceName}</span>
              <Button onClick={disconnect} className="ml-4 px-2 py-1 text-xs rounded hover:opacity-90">Disconnect</Button>
          </div>
          <div className="mb-2 text-sm">Streaming EEG data...</div>
        </>
      )}
      {bleState === "error" && (
        <div className="mb-2">Error: {error}</div>
      )}
      <div className="mt-4">
        <h3 className="font-semibold mb-2">EEG Data (Live)</h3>
        <div className="h-48 border border-border rounded p-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#444" />
              <XAxis dataKey="timestamp" tick={false} axisLine={false} />
              <YAxis domain={["auto", "auto"]} tick={{ fill: "#aaa" }} width={40} />
              <Tooltip contentStyle={{ background: "#222", border: "none", color: "#fff" }} labelFormatter={() => ""} />
              <Line type="monotone" dataKey="value" stroke="#a78bfa" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      {sessionEnded && (
        <div className="mt-6 p-4 rounded">
          <h3 className="font-bold mb-2">Session Complete!</h3>
          <div>Stages recorded: {stageHistory.length}</div>
          <div className="mt-2 text-xs">(Ready to save to backend)</div>
          <div className="mt-4">
            {stageHistory.map((stage, i) => {
              const result = processEegData(participant, stage.eegData);
              console.log(`Stage ${i + 1} processing result:`, result);
              
              return (
                <div key={i} className="mb-2 p-2 rounded">
                  <div className="font-semibold">Stage {stage.stageOrder}: {stage.stageName}</div>
                  <div>Focus Level: {
                    result.error ? 
                      `Error: ${result.error}` : 
                      (result.focus_level !== undefined && result.focus_level !== null ? 
                        result.focus_level.toFixed(1) : 
                        "0.0")
                  }</div>
                  <div>Beta Power: {
                    result.error ? 
                      "-" : 
                      (result.beta_power !== undefined && result.beta_power !== null ? 
                        result.beta_power.toFixed(6) : 
                        "0.000000")
                  }</div>
                  <div>Low Beta Warning: {result.low_beta_warning ? "Yes" : "No"}</div>
                  <div>Data Points: {stage.eegData.length}</div>
                  {result.error && (
                    <div className="text-sm mt-1">Processing Error: {result.error}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-4">
            <Button
              onClick={saveSessionToBackend}
              disabled={saveStatus === 'saving' || saveStatus === 'success'}
              className="hover:opacity-90 px-4 py-2 rounded"
            >
              {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'success' ? 'Saved!' : 'Save to backend'}
            </Button>
            {saveStatus === 'error' && (
              <div className="mt-2 text-sm">Error: {saveError}</div>
            )}
            {saveStatus === 'success' && (
              <div className="mt-2 text-sm">Session saved successfully!</div>
            )}
          </div>
        </div>
      )}
      {sessionEnded && stageHistory.length === 0 && (
        <div className="mt-4 p-2 rounded border">
          <p className="mb-2">Debug: No stages recorded</p>
          <Button 
            onClick={saveSessionToBackend}
            className="hover:opacity-90 px-4 py-2 rounded"
          >
            Force Save (Debug)
          </Button>
        </div>
      )}
      {awaitingContinue && (
        <div className="mt-4 p-4 rounded flex flex-col gap-2 border">
          <div className="mb-2">Do you want to continue to the next stage?</div>
          <div className="flex gap-4">
            <Button onClick={handleContinueStage} className="hover:opacity-90">Continue</Button>
            <Button onClick={handleFinishSession} className="hover:opacity-90">Finish</Button>
          </div>
        </div>
      )}
    </div>
  );
} 