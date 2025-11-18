"use client";
import React, { useState, useRef, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell } from "recharts";
import { Button } from "@/components/ui/button";
import { processEegData, calculate5BandPSD, SAMPLING_RATE } from "@/lib/eegUtils";

const SERVICE_UUID = "0338ff7c-6251-4029-a5d5-24e4fa856c8d";
const CHARACTERISTIC_UUID = "ad615f2b-cc93-4155-9e4d-f5f32cb9a2d7";

const DEFAULT_SESSION_DURATION = 300; // 5 minutes default

type BleState = "idle" | "scanning" | "connecting" | "connected" | "error";

interface EegDatum {
  value: number;
  timestamp: number;
}



// Frequency Band Chart Component
function FrequencyBandChart({ data }: { data: EegDatum[] }) {
  const bandData = useMemo(() => {
    if (data.length < 32) {
      return [
        { name: "Delta", value: 0, color: "#3b82f6" },
        { name: "Theta", value: 0, color: "#8b5cf6" },
        { name: "Alpha", value: 0, color: "#ec4899" },
        { name: "Beta", value: 0, color: "#f59e0b" },
        { name: "Gamma", value: 0, color: "#10b981" },
      ];
    }

    // Use recent data for calculation (last 512 samples or available)
    const recentData = data.slice(-512).map(d => d.value);
    const bandPSD = calculate5BandPSD(recentData, SAMPLING_RATE);

    return [
      { name: "Delta", value: bandPSD.delta, color: "#3b82f6" },
      { name: "Theta", value: bandPSD.theta, color: "#8b5cf6" },
      { name: "Alpha", value: bandPSD.alpha, color: "#ec4899" },
      { name: "Beta", value: bandPSD.beta, color: "#f59e0b" },
      { name: "Gamma", value: bandPSD.gamma, color: "#10b981" },
    ];
  }, [data]);

  return (
    <div className="h-64 border border-border rounded p-2">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bandData} margin={{ top: 10, right: 10, left: 60, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#444" />
          <XAxis 
            dataKey="name" 
            tick={{ fill: "#aaa" }} 
            axisLine={{ stroke: "#444" }}
            tickLine={{ stroke: "#444" }}
          />
          <YAxis 
            tick={{ fill: "#aaa" }} 
            axisLine={{ stroke: "#444" }}
            tickLine={{ stroke: "#444" }}
            width={60}
          />
          <Tooltip 
            contentStyle={{ background: "#222", border: "none", color: "#fff" }}
            formatter={(value: number) => [value.toFixed(6), "PSD"]}
          />
          <Bar dataKey="value" isAnimationActive={false}>
            {bandData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function BleReader() {
  const [bleState, setBleState] = useState<BleState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [participant, setParticipant] = useState("");
  const [participantSaved, setParticipantSaved] = useState(false);
  const [sessionType, setSessionType] = useState<"baseline" | "focus">("baseline");
  const [sessionDuration, setSessionDuration] = useState(DEFAULT_SESSION_DURATION);
  const [data, setData] = useState<EegDatum[]>([]);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [timer, setTimer] = useState(DEFAULT_SESSION_DURATION);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const sessionStartTimeRef = useRef<number | null>(null);
  const characteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);


  // Start session timer
  const startSession = () => {
    console.log("Starting session - will collect data now");
    setSessionActive(true);
    setSessionEnded(false);
    setTimer(sessionDuration);
    sessionStartTimeRef.current = Date.now();
    setData([]);
    console.log("Session active set to true, data cleared");
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

  // End session - automatically download JSON
  const endSession = async () => {
    console.log("Ending session, collected", data.length, "data points");
    setSessionActive(false);
    setSessionEnded(true);
    setIsStreaming(false);
    setBleState("idle");
    if (timerRef.current) clearInterval(timerRef.current);
    
    // Automatically download JSON if we have data
    if (data.length > 0) {
      downloadDataAsJSON();
    }
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

  // Use ref to track sessionActive so event listener always has latest value
  const sessionActiveRef = useRef(false);
  React.useEffect(() => {
    sessionActiveRef.current = sessionActive;
  }, [sessionActive]);

  // Handle incoming BLE notifications - collect raw data directly
  const handleNotification = React.useCallback((event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) {
      console.log("No value in notification");
      return;
    }
    const decoder = new TextDecoder("utf-8");
    const str = decoder.decode(value.buffer);
    const num = parseInt(str, 10);
    if (isNaN(num)) {
      console.log("Failed to parse number from:", str);
      return;
    }
    
    // Only collect if session is active - collect ALL data points, no limits
    if (sessionActiveRef.current) {
      setData((prev) => {
        const newData = [
          ...prev,
          {
            value: num,
            timestamp: Date.now(),
          },
        ];
        // Log every 100th sample to avoid spam
        if (prev.length % 100 === 0) {
          console.log(`Collected ${newData.length} samples, latest value: ${num}`);
        }
        // Return ALL data - no slicing, no limits
        return newData;
      });
    } else {
      console.log("Notification received but session not active, value:", num);
    }
  }, []);

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

  // Download data as JSON file
  function downloadDataAsJSON() {
    if (data.length === 0) {
      console.error("No data to download");
      setSaveError("No data collected");
      setSaveStatus('error');
      return;
    }
    
    setSaveStatus('saving');
    setSaveError(null);
    
    try {
      const startedAt = sessionStartTimeRef.current || Date.now() - (sessionDuration * 1000);
      const participantNameWithType = participant ? `${participant}-${sessionType}` : `unknown-${sessionType}`;
      const jsonData = {
        participantName: participantNameWithType,
        startedAt,
        durationSeconds: sessionDuration,
        totalSamples: data.length,
        eegData: data.map(d => ({
          value: d.value,
          timestamp: d.timestamp,
        })),
      };
      
      // Create JSON blob
      const jsonString = JSON.stringify(jsonData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      // Create download link
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `eeg-data-${participantNameWithType}-${timestamp}.json`;
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      console.log(`Downloaded ${data.length} data points as ${filename}`);
      setSaveStatus('success');
    } catch (err: any) {
      console.error('[downloadDataAsJSON] Error:', err);
      setSaveStatus('error');
      setSaveError(err.message || String(err));
    }
  }


  // UI
  return (
    <div className="max-w-3xl mx-auto p-6 rounded-xl shadow mt-8">
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        Neurofocus V4 Dashboard
        <span className={`inline-block w-2 h-2 rounded-full ml-2 ${bleState === "connected" ? "status-connected" : bleState === "error" ? "status-error" : "status-idle"}`}></span>
      </h2>
      {!participantSaved ? (
        <div className="mb-4 space-y-3">
          <form onSubmit={handleSaveParticipant} className="flex gap-2">
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
          <div className="flex gap-2">
            <Button
              onClick={() => setSessionType("baseline")}
              className={`flex-1 px-4 py-2 rounded transition ${
                sessionType === "baseline" 
                  ? "bg-blue-600 text-white" 
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              Baseline
            </Button>
            <Button
              onClick={() => setSessionType("focus")}
              className={`flex-1 px-4 py-2 rounded transition ${
                sessionType === "focus" 
                  ? "bg-blue-600 text-white" 
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              Focus
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium whitespace-nowrap">Session Duration:</label>
            <input
              type="number"
              min="10"
              max="3600"
              step="10"
              value={sessionDuration}
              onChange={e => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 10) {
                  setSessionDuration(val);
                }
              }}
              className="flex-1 px-3 py-2 rounded border border-input"
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              ({Math.floor(sessionDuration / 60)}m {sessionDuration % 60}s)
            </span>
          </div>
          {participant && (
            <div className="text-sm text-muted-foreground">
              Participant: <span className="font-mono">{participant}-{sessionType}</span>
            </div>
          )}
        </div>
      ) : null}
      {participantSaved && bleState === "idle" && !sessionActive && !sessionEnded && (
        <Button onClick={connect} className="mb-4 px-4 py-2 rounded transition">Connect to EEG Device</Button>
      )}
      {participantSaved && bleState === "connected" && !sessionActive && !sessionEnded && (
        <Button
          onClick={startSession}
          className="mb-4 px-4 py-2 rounded hover:opacity-90 transition"
        >
          Start Session
        </Button>
      )}
      {sessionActive && (
        <div className="mb-4 flex items-center gap-4">
          <span className="font-medium">Time Left:</span>
          <span className="text-lg font-mono">{Math.floor(timer/60).toString().padStart(2,'0')}:{(timer%60).toString().padStart(2,'0')}</span>
        </div>
      )}
      {participantSaved && (
        <div className="mb-4 flex items-center gap-4 flex-wrap">
          <span className="font-medium">Participant:</span>
          <span className="font-mono">{participant}-{sessionType}</span>
          <span className="font-medium ml-4">Duration:</span>
          <span className="font-mono">{Math.floor(sessionDuration / 60)}m {sessionDuration % 60}s</span>
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
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">EEG Data (Live)</h3>
          <div className="flex items-center gap-4">
            {isStreaming && (
              <div className="text-sm text-muted-foreground font-mono">
                Samples: {data.length} (showing last 250)
              </div>
            )}
          </div>
        </div>
        <div className="h-48 border border-border rounded p-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.slice(-250)} margin={{ top: 10, right: 10, left: 50, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#444" />
              <XAxis dataKey="timestamp" tick={false} axisLine={false} />
              <YAxis domain={["auto", "auto"]} tick={{ fill: "#aaa" }} width={50} />
              <Tooltip contentStyle={{ background: "#222", border: "none", color: "#fff" }} labelFormatter={() => ""} />
              <Line type="monotone" dataKey="value" stroke="#a78bfa" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      {isStreaming && data.length >= 32 && (
        <div className="mt-4">
          <h3 className="font-semibold mb-2">Frequency Band PSD (5-60 Hz)</h3>
          <FrequencyBandChart data={data} />
        </div>
      )}
      {sessionEnded && (
        <div className="mt-6 p-4 rounded">
          <h3 className="font-bold mb-2">Session Complete!</h3>
          <div className="mb-2">Data Points Collected: {data.length}</div>
          {saveStatus === 'saving' && (
            <div className="mt-2 text-sm">Downloading JSON...</div>
          )}
          {saveStatus === 'success' && (
            <div className="mt-2 text-sm text-green-500">JSON file downloaded successfully!</div>
          )}
          {saveStatus === 'error' && (
            <div className="mt-2 text-sm text-red-500">Error: {saveError}</div>
          )}
          {data.length > 0 && saveStatus !== 'saving' && (
            <Button
              onClick={downloadDataAsJSON}
              className="mt-4 px-4 py-2 rounded hover:opacity-90"
            >
              Download JSON Again
            </Button>
          )}
        </div>
      )}
    </div>
  );
} 