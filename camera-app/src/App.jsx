import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { 
  Camera, Video, VideoOff, Wifi, WifiOff, 
  Copy, Check, RotateCcw, Moon, Sun, Activity, Battery, Signal,
  Mic, MicOff, Volume2, Settings, Users, Eye, AlertCircle, Zap, Phone
} from 'lucide-react';

const SERVER_URL = 'https://fermanta-baby-monitor-server.hf.space';

export default function CameraApp() {
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  
  const [connectedMonitors, setConnectedMonitors] = useState(new Map());
  const [copied, setCopied] = useState(false);
  
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [micMuted, setMicMuted] = useState(false);
  const [facingMode, setFacingMode] = useState('environment');
  const [audioLevel, setAudioLevel] = useState(0);
  
  const [babyStatus, setBabyStatus] = useState('unknown');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const [nightMode, setNightMode] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState([]);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const pendingConnectionsRef = useRef(new Set());
  const analysisIntervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const audioIntervalRef = useRef(null);

  const addDebugLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${type.toUpperCase()}] ${message}`);
    setDebugLogs(prev => [{
      time: timestamp,
      message,
      type
    }, ...prev.slice(0, 49)]);
  }, []);

  useEffect(() => {
    addDebugLog('Connecting to server...');
    
    const newSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socketRef.current = newSocket;

    newSocket.on('connect', () => {
      addDebugLog('✅ Socket connected: ' + newSocket.id, 'success');
      setSocketConnected(true);
      setError('');
    });

    newSocket.on('disconnect', (reason) => {
      addDebugLog(`❌ Disconnected: ${reason}`, 'error');
      setSocketConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      addDebugLog(`❌ Connection error: ${err.message}`, 'error');
      setError('Gagal terhubung ke server');
      setSocketConnected(false);
    });

    newSocket.on('camera-joined', ({ roomCode }) => {
      addDebugLog(`✅ Joined room: ${roomCode}`, 'success');
      setIsConnected(true);
    });

    newSocket.on('monitor-connected', async ({ monitorId }) => {
      addDebugLog(`📺 Monitor connected: ${monitorId}`);
      
      if (pendingConnectionsRef.current.has(monitorId)) {
        addDebugLog(`⏭️ Skipping duplicate for: ${monitorId}`, 'warning');
        return;
      }

      const existingPeer = peerConnectionsRef.current.get(monitorId);
      if (existingPeer) {
        const state = existingPeer.connectionState;
        if (state === 'connected' || state === 'connecting') {
          addDebugLog(`✅ Already ${state} to: ${monitorId}`, 'warning');
          return;
        }
      }

      setConnectedMonitors(prev => {
        const newMap = new Map(prev);
        newMap.set(monitorId, { 
          id: monitorId, 
          status: 'connecting', 
          connectedAt: null 
        });
        return newMap;
      });

      await createPeerConnection(monitorId, newSocket);
    });

    newSocket.on('monitor-disconnected', ({ monitorId }) => {
      addDebugLog(`📴 Monitor disconnected: ${monitorId}`, 'warning');
      
      setConnectedMonitors(prev => {
        const newMap = new Map(prev);
        newMap.delete(monitorId);
        return newMap;
      });

      const pc = peerConnectionsRef.current.get(monitorId);
      if (pc) {
        pc.close();
        peerConnectionsRef.current.delete(monitorId);
        addDebugLog(`🗑️ Cleaned up peer: ${monitorId}`);
      }

      pendingConnectionsRef.current.delete(monitorId);
    });

    newSocket.on('answer', async ({ answer, senderId }) => {
      addDebugLog(`📥 Received answer from: ${senderId}`);
      
      const pc = peerConnectionsRef.current.get(senderId);
      if (!pc) {
        addDebugLog(`⚠️ No peer connection for: ${senderId}`, 'warning');
        return;
      }

      if (pc.signalingState !== 'have-local-offer') {
        addDebugLog(`⚠️ Wrong signaling state: ${pc.signalingState}`, 'warning');
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        addDebugLog(`✅ Remote description set for: ${senderId}`, 'success');
      } catch (err) {
        addDebugLog(`❌ Error setting remote description: ${err.message}`, 'error');
      }
    });

    newSocket.on('ice-candidate', async ({ candidate, senderId }) => {
      const pc = peerConnectionsRef.current.get(senderId);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          addDebugLog(`🧊 Added ICE candidate from: ${senderId}`);
        } catch (e) {
          addDebugLog(`❌ ICE error: ${e.message}`, 'error');
        }
      }
    });

    newSocket.on('error', ({ message }) => {
      addDebugLog(`❌ Server error: ${message}`, 'error');
      setError(message);
    });

    setSocket(newSocket);

    return () => {
      addDebugLog('🧹 Cleaning up socket...');
      newSocket.disconnect();
    };
  }, [addDebugLog]);

  const startAudioMonitoring = useCallback((stream) => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      
      analyser.fftSize = 256;
      microphone.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      audioIntervalRef.current = setInterval(() => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          setAudioLevel(Math.min(100, average * 1.5));
        }
      }, 100);
      
      addDebugLog('🎙️ Audio monitoring started', 'success');
    } catch (err) {
      addDebugLog(`❌ Audio monitoring error: ${err.message}`, 'error');
    }
  }, [addDebugLog]);

  const stopAudioMonitoring = useCallback(() => {
    if (audioIntervalRef.current) {
      clearInterval(audioIntervalRef.current);
      audioIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
    addDebugLog('🎙️ Audio monitoring stopped');
  }, [addDebugLog]);

  const createPeerConnection = async (monitorId, socket) => {
    if (pendingConnectionsRef.current.has(monitorId)) {
      addDebugLog(`⏭️ Already creating connection for: ${monitorId}`, 'warning');
      return;
    }

    pendingConnectionsRef.current.add(monitorId);
    addDebugLog(`🔧 Creating peer connection for: ${monitorId}`);

    const oldPc = peerConnectionsRef.current.get(monitorId);
    if (oldPc) {
      oldPc.close();
      addDebugLog(`🗑️ Closed old peer connection for: ${monitorId}`);
    }

    const configuration = {
      iceServers: [
        { urls: "stun:stun.relay.metered.ca:80" },
        {
          urls: "turn:global.relay.metered.ca:80",
          username: "425f63dce2848b19b6115cc3",
          credential: "R4IGN2IpEXFZPIMw",
        },
        {
          urls: "turn:global.relay.metered.ca:80?transport=tcp",
          username: "425f63dce2848b19b6115cc3",
          credential: "R4IGN2IpEXFZPIMw",
        },
        {
          urls: "turn:global.relay.metered.ca:443",
          username: "425f63dce2848b19b6115cc3",
          credential: "R4IGN2IpEXFZPIMw",
        },
        {
          urls: "turns:global.relay.metered.ca:443?transport=tcp",
          username: "425f63dce2848b19b6115cc3",
          credential: "R4IGN2IpEXFZPIMw",
        },
      ],
      iceCandidatePoolSize: 10
    };
    
    try {
      const pc = new RTCPeerConnection(configuration);
      peerConnectionsRef.current.set(monitorId, pc);

      if (streamRef.current) {
        const tracks = streamRef.current.getTracks();
        addDebugLog(`📤 Adding ${tracks.length} tracks to peer connection`);
        
        tracks.forEach(track => {
          pc.addTrack(track, streamRef.current);
          addDebugLog(`  - Adding ${track.kind} track (enabled: ${track.enabled})`);
        });
      } else {
        addDebugLog(`❌ No stream available!`, 'error');
        pendingConnectionsRef.current.delete(monitorId);
        return;
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            candidate: event.candidate,
            targetId: monitorId
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        addDebugLog(`🔌 Connection state [${monitorId}]: ${state}`);

        setConnectedMonitors(prev => {
          const newMap = new Map(prev);
          const monitor = newMap.get(monitorId);
          if (monitor) {
            monitor.status = state;
            if (state === 'connected') {
              monitor.connectedAt = new Date();
            }
          }
          return newMap;
        });

        if (state === 'connected') {
          addDebugLog(`✅ WebRTC Connected with audio to: ${monitorId}!`, 'success');
          pendingConnectionsRef.current.delete(monitorId);
        } 
        else if (state === 'failed' || state === 'closed') {
          addDebugLog(`❌ Connection ${state}: ${monitorId}`, 'error');
          pendingConnectionsRef.current.delete(monitorId);
          
          setTimeout(() => {
            const currentPc = peerConnectionsRef.current.get(monitorId);
            if (currentPc === pc) {
              pc.close();
              peerConnectionsRef.current.delete(monitorId);
              addDebugLog(`🗑️ Cleaned up failed peer: ${monitorId}`);
            }
          }, 3000);
        }
        else if (state === 'disconnected') {
          addDebugLog(`⚠️ Temporarily disconnected: ${monitorId}`, 'warning');
        }
      };

      pc.oniceconnectionstatechange = () => {
        addDebugLog(`🧊 ICE state [${monitorId}]: ${pc.iceConnectionState}`);
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      
      await pc.setLocalDescription(offer);
      
      addDebugLog(`📤 Sending offer with audio to: ${monitorId}`);
      socket.emit('offer', {
        offer: pc.localDescription,
        targetId: monitorId
      });

    } catch (err) {
      addDebugLog(`❌ Error creating offer: ${err.message}`, 'error');
      pendingConnectionsRef.current.delete(monitorId);
      
      const pc = peerConnectionsRef.current.get(monitorId);
      if (pc) {
        pc.close();
        peerConnectionsRef.current.delete(monitorId);
      }
    }
  };

  const toggleMic = useCallback(() => {
    if (streamRef.current) {
      const audioTracks = streamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = micMuted;
        addDebugLog(`🎙️ Microphone ${track.enabled ? 'unmuted' : 'muted'}`);
      });
      setMicMuted(!micMuted);
    }
  }, [micMuted, addDebugLog]);

  const generateRoom = async () => {
    try {
      setError('');
      addDebugLog('Generating room code...');
      
      const response = await fetch(`${SERVER_URL}/api/generate-room`);
      const data = await response.json();
      
      setRoomCode(data.roomCode);
      addDebugLog(`🔑 Room code generated: ${data.roomCode}`, 'success');
    } catch (err) {
      addDebugLog(`❌ Error generating room: ${err.message}`, 'error');
      setError('Gagal generate room. Periksa koneksi internet.');
    }
  };

  const startCamera = async () => {
    try {
      setError('');
      addDebugLog('📷 Starting camera with audio...');
      
      const constraints = {
        video: { 
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: audioEnabled ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100
        } : false
      };
      
      addDebugLog(`📋 Media constraints: ${JSON.stringify(constraints)}`);
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();
      
      addDebugLog(`✅ Got ${videoTracks.length} video track(s)`, 'success');
      addDebugLog(`✅ Got ${audioTracks.length} audio track(s)`, 'success');
      
      if (audioTracks.length > 0) {
        addDebugLog(`🎙️ Audio settings: ${JSON.stringify(audioTracks[0].getSettings())}`);
        startAudioMonitoring(stream);
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      streamRef.current = stream;
      setIsStreaming(true);

      if (socket && roomCode) {
        socket.emit('camera-join', { roomCode });
        addDebugLog(`📡 Joining room: ${roomCode}`);
      }

      startAnalysis();

    } catch (err) {
      addDebugLog(`❌ Camera error: ${err.message}`, 'error');
      
      if (err.name === 'NotAllowedError') {
        setError('Izin kamera/mikrofon ditolak. Silakan izinkan akses di pengaturan browser.');
      } else if (err.name === 'NotFoundError') {
        setError('Kamera atau mikrofon tidak ditemukan.');
      } else {
        setError('Gagal mengakses kamera: ' + err.message);
      }
    }
  };

  const stopCamera = () => {
    addDebugLog('🛑 Stopping camera...');
    
    stopAudioMonitoring();
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        addDebugLog(`  - Stopped ${track.kind} track`);
      });
      streamRef.current = null;
    }
    
    peerConnectionsRef.current.forEach((pc, id) => {
      pc.close();
      addDebugLog(`  - Closed peer connection: ${id}`);
    });
    peerConnectionsRef.current.clear();
    pendingConnectionsRef.current.clear();
    setConnectedMonitors(new Map());
    
    setIsStreaming(false);
    setIsConnected(false);
    setMicMuted(false);
    
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
    }
  };

  const switchCamera = async () => {
    const newFacing = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newFacing);
    
    if (isStreaming) {
      stopCamera();
      setTimeout(() => startCamera(), 500);
    }
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    addDebugLog('📋 Room code copied');
    setTimeout(() => setCopied(false), 2000);
  };

  const analyzeFrame = async () => {
    if (!videoRef.current || !canvasRef.current || !socket) return;

    setIsAnalyzing(true);
    
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    
    if (nightMode) {
      ctx.filter = 'brightness(1.5) contrast(1.2)';
    }
    ctx.drawImage(video, 0, 0);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.5);

    socket.emit('baby-status-update', {
      roomCode,
      status: babyStatus,
      confidence: 0,
      notes: 'Live monitoring',
      position: 'unknown',
      alert: false,
      imageData: imageData
    });

    setIsAnalyzing(false);
  };

  const startAnalysis = () => {
    setTimeout(analyzeFrame, 2000);
    analysisIntervalRef.current = setInterval(analyzeFrame, 15000);
  };

  const updateStatus = (status) => {
    setBabyStatus(status);
    addDebugLog(`👶 Status updated: ${status}`);
    
    if (socket && roomCode) {
      socket.emit('baby-status-update', {
        roomCode,
        status,
        confidence: 100,
        notes: 'Manual update',
        position: 'unknown',
        alert: status === 'awake'
      });
    }
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  const activeMonitors = Array.from(connectedMonitors.values()).filter(
    m => m.status === 'connected'
  ).length;

  const connectingMonitors = Array.from(connectedMonitors.values()).filter(
    m => m.status === 'connecting'
  ).length;

  // ============================================
  // RENDER - NEW DESIGN
  // ============================================

  return (
    <div className={`min-h-screen transition-all duration-500 ${
      nightMode 
        ? 'bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800' 
        : 'bg-gradient-to-br from-blue-50 via-white to-purple-50'
    }`}>
      <div className="max-w-lg mx-auto px-4 py-6">
        
        {/* ============ HEADER ============ */}
        <HeaderCamera 
          nightMode={nightMode}
          socketConnected={socketConnected}
          isStreaming={isStreaming}
          audioEnabled={audioEnabled}
          showSettings={showSettings}
          setShowSettings={setShowSettings}
          setNightMode={setNightMode}
          showDebug={showDebug}
          setShowDebug={setShowDebug}
        />

        {/* ============ ERROR BANNER ============ */}
        {error && (
          <ErrorBanner error={error} nightMode={nightMode} setError={setError} />
        )}

        {/* ============ SETTINGS PANEL ============ */}
        {showSettings && !isStreaming && (
          <SettingsPanel 
            nightMode={nightMode}
            audioEnabled={audioEnabled}
            setAudioEnabled={setAudioEnabled}
            facingMode={facingMode}
            setFacingMode={setFacingMode}
          />
        )}

        {/* ============ ROOM CODE SECTION ============ */}
        {!isStreaming && (
          <RoomCodeSection 
            nightMode={nightMode}
            roomCode={roomCode}
            socketConnected={socketConnected}
            copied={copied}
            generateRoom={generateRoom}
            copyRoomCode={copyRoomCode}
          />
        )}

        {/* ============ CAMERA PREVIEW ============ */}
        <CameraPreviewSection 
          nightMode={nightMode}
          videoRef={videoRef}
          isStreaming={isStreaming}
          isConnected={isConnected}
          activeMonitors={activeMonitors}
          connectingMonitors={connectingMonitors}
          audioEnabled={audioEnabled}
          micMuted={micMuted}
          audioLevel={audioLevel}
          babyStatus={babyStatus}
          isAnalyzing={isAnalyzing}
          startCamera={startCamera}
          stopCamera={stopCamera}
          switchCamera={switchCamera}
          toggleMic={toggleMic}
          updateStatus={updateStatus}
        />

        {canvasRef && <canvas ref={canvasRef} className="hidden" />}

        {/* ============ CONNECTION STATUS ============ */}
        {isStreaming && (
          <ConnectionStatus 
            nightMode={nightMode}
            isConnected={isConnected}
            activeMonitors={activeMonitors}
            micMuted={micMuted}
            babyStatus={babyStatus}
          />
        )}

        {/* ============ DEBUG PANEL ============ */}
        {showDebug && (
          <DebugPanelCamera 
            nightMode={nightMode}
            debugLogs={debugLogs}
            setDebugLogs={setDebugLogs}
            connectedMonitors={connectedMonitors}
            pendingConnectionsRef={pendingConnectionsRef}
          />
        )}

        {/* ============ INFO TIP ============ */}
        <div className={`mt-6 backdrop-blur-xl rounded-2xl border ${
          nightMode
            ? 'bg-indigo-500/10 border-indigo-500/30'
            : 'bg-indigo-50/80 border-indigo-200'
        } p-4`}>
          <p className={`text-sm ${nightMode ? 'text-indigo-200' : 'text-indigo-700'}`}>
            💡 <strong>Tips:</strong> 
            {!isStreaming 
              ? ' Aktifkan mikrofon di pengaturan untuk mendengar suara bayi di PC.'
              : ' Pastikan HP terhubung ke charger dan volume HP tidak terlalu tinggi untuk menghindari feedback.'
            }
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: HEADER CAMERA
// ============================================
function HeaderCamera({ 
  nightMode, socketConnected, isStreaming, audioEnabled,
  showSettings, setShowSettings, setNightMode, showDebug, setShowDebug 
}) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all duration-300 mb-6 shadow-lg ${
      nightMode
        ? 'bg-gradient-to-r from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-r from-white/50 to-blue-50/50 border-white/60'
    } p-4`}>
      <div className="flex items-center justify-between">
        
        {/* LOGO & TITLE */}
        <div className="flex items-center gap-3">
          <div className={`relative group rounded-2xl p-3 transition-all ${
            nightMode
              ? 'bg-gradient-to-br from-red-600 to-pink-600'
              : 'bg-gradient-to-br from-red-500 to-pink-500'
          } shadow-lg hover:scale-105`}>
            <Camera className="w-6 h-6 text-white" />
          </div>
          
          <div>
            <h1 className={`text-2xl font-bold bg-clip-text bg-gradient-to-r ${
              nightMode
                ? 'from-red-300 via-pink-300 to-rose-300 text-transparent'
                : 'from-red-600 via-pink-600 to-rose-600 text-transparent'
            }`}>
              Camera App
            </h1>
            <div className="flex items-center gap-2 text-xs mt-1">
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${
                socketConnected
                  ? nightMode
                    ? 'bg-green-500/30 text-green-300'
                    : 'bg-green-100 text-green-700'
                  : nightMode
                    ? 'bg-red-500/30 text-red-300'
                    : 'bg-red-100 text-red-700'
              }`}>
                {socketConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {socketConnected ? 'Online' : 'Offline'}
              </span>
              {isStreaming && audioEnabled && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                  <Mic className="w-3 h-3" />
                  Audio
                </span>
              )}
            </div>
          </div>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-2">
          {!isStreaming && (
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2.5 rounded-xl transition-all ${
                showSettings
                  ? nightMode
                    ? 'bg-indigo-600 text-white'
                    : 'bg-indigo-500 text-white'
                  : nightMode
                    ? 'bg-slate-700/50 text-slate-300 hover:bg-slate-600/50'
                    : 'bg-white/50 text-slate-600 hover:bg-white/70'
              }`}
              title="Pengaturan"
            >
              <Settings className="w-5 h-5" />
            </button>
          )}
          
          <button
            onClick={() => setNightMode(prev => !prev)}
            className={`p-2.5 rounded-xl transition-all ${
              nightMode
                ? 'bg-yellow-500 text-white'
                : 'bg-slate-800 text-white'
            }`}
            title="Dark Mode"
          >
            {nightMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          
          <button
            onClick={() => setShowDebug(prev => !prev)}
            className={`p-2.5 rounded-xl transition-all ${
              showDebug
                ? nightMode
                  ? 'bg-purple-600 text-white'
                  : 'bg-purple-500 text-white'
                : nightMode
                  ? 'bg-slate-700/50 text-slate-300 hover:bg-slate-600/50'
                  : 'bg-white/50 text-slate-600 hover:bg-white/70'
            }`}
            title="Debug"
          >
            <Activity className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: ERROR BANNER
// ============================================
function ErrorBanner({ error, nightMode, setError }) {
  return (
    <div className={`mb-4 backdrop-blur-lg rounded-2xl border-l-4 border-red-500 ${
      nightMode 
        ? 'bg-red-500/10' 
        : 'bg-red-50/80'
    } px-6 py-4 flex items-center gap-3 animate-in slide-in-from-top duration-300`}>
      <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
      <div className="flex-1">
        <p className={`font-medium ${nightMode ? 'text-red-300' : 'text-red-800'}`}>
          {error}
        </p>
      </div>
      <button 
        onClick={() => setError('')}
        className={`text-lg opacity-60 hover:opacity-100 ${nightMode ? 'text-red-300' : 'text-red-600'}`}
      >
        ✕
      </button>
    </div>
  );
}

// ============================================
// COMPONENT: SETTINGS PANEL
// ============================================
function SettingsPanel({ nightMode, audioEnabled, setAudioEnabled, facingMode, setFacingMode }) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all mb-6 ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } p-6 shadow-xl animate-in slide-in-from-top duration-300`}>
      <h3 className={`font-bold mb-4 text-lg ${nightMode ? 'text-white' : 'text-gray-800'}`}>
        ⚙️ Pengaturan Streaming
      </h3>
      
      {/* Audio Toggle */}
      <div className={`flex items-center justify-between py-4 border-b ${nightMode ? 'border-slate-600' : 'border-gray-200'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${audioEnabled ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
            <Mic className={`w-5 h-5 ${audioEnabled ? 'text-green-500' : 'text-red-500'}`} />
          </div>
          <div>
            <p className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              Mikrofon
            </p>
            <p className={`text-xs ${nightMode ? 'text-slate-400' : 'text-gray-500'}`}>
              Streaming suara ke monitor
            </p>
          </div>
        </div>
        <button
          onClick={() => setAudioEnabled(!audioEnabled)}
          className={`relative w-14 h-8 rounded-full transition-all ${
            audioEnabled ? 'bg-green-500' : 'bg-gray-300'
          }`}
        >
          <span className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full transition-transform duration-200 ${
            audioEnabled ? 'translate-x-6' : 'translate-x-0'
          }`} />
        </button>
      </div>

      {/* Camera Selection */}
      <div className="flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${nightMode ? 'bg-slate-700' : 'bg-gray-100'}`}>
            <RotateCcw className={`w-5 h-5 ${nightMode ? 'text-slate-400' : 'text-gray-600'}`} />
          </div>
          <div>
            <p className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              Kamera
            </p>
            <p className={`text-xs ${nightMode ? 'text-slate-400' : 'text-gray-500'}`}>
              {facingMode === 'environment' ? '📱 Belakang' : '🤳 Depan'}
            </p>
          </div>
        </div>
        <button
          onClick={() => setFacingMode(f => f === 'environment' ? 'user' : 'environment')}
          className={`px-4 py-2 rounded-xl font-semibold transition-all ${
            nightMode
              ? 'bg-indigo-600 text-white hover:bg-indigo-700'
              : 'bg-indigo-500 text-white hover:bg-indigo-600'
          }`}
        >
          Ganti
        </button>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: ROOM CODE SECTION
// ============================================
function RoomCodeSection({ nightMode, roomCode, socketConnected, copied, generateRoom, copyRoomCode }) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all mb-6 ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } p-6 shadow-xl animate-in fade-in duration-500`}>
      <h2 className={`text-lg font-bold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
        🔗 Kode Ruangan
      </h2>
      
      {!roomCode ? (
        <div className="space-y-3">
          <button
            onClick={generateRoom}
            disabled={!socketConnected}
            className={`w-full py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 ${
              socketConnected
                ? 'bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white shadow-lg hover:scale-105 active:scale-95'
                : 'bg-gray-400 text-gray-600 cursor-not-allowed'
            }`}
          >
            <Zap className="w-5 h-5" />
            Generate Kode Ruangan
          </button>
          {!socketConnected && (
            <p className="text-sm text-red-500 text-center">Tunggu server terhubung...</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className={`p-6 rounded-2xl flex items-center justify-between border-2 ${
            nightMode
              ? 'bg-slate-700/50 border-slate-600'
              : 'bg-gradient-to-r from-indigo-50 to-purple-50 border-indigo-200'
          }`}>
            <span className={`text-4xl font-mono font-black tracking-widest ${
              nightMode ? 'text-white' : 'text-indigo-700'
            }`}>
              {roomCode}
            </span>
            <button
              onClick={copyRoomCode}
              className={`p-3 rounded-xl transition-all hover:scale-110 ${
                copied
                  ? 'bg-green-500 text-white'
                  : nightMode
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600'
              }`}
              title="Copy"
            >
              {copied ? <Check className="w-6 h-6" /> : <Copy className="w-6 h-6" />}
            </button>
          </div>
          <p className={`text-sm text-center font-medium ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>
            📲 Bagikan kode ini ke Monitor App
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================
// COMPONENT: CAMERA PREVIEW
// ============================================
function CameraPreviewSection({
  nightMode, videoRef, isStreaming, isConnected, activeMonitors, connectingMonitors,
  audioEnabled, micMuted, audioLevel, babyStatus, isAnalyzing,
  startCamera, stopCamera, switchCamera, toggleMic, updateStatus
}) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all mb-6 ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } p-4 shadow-xl`}>
      {/* VIDEO CONTAINER */}
      <div className="relative bg-black rounded-2xl overflow-hidden mb-4" style={{ aspectRatio: '16/9' }}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`w-full h-full object-cover ${nightMode ? 'brightness-125' : ''}`}
        />
        
        {!isStreaming && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-black/50 to-black/80">
            <VideoOff className="w-20 h-20 text-gray-500 mb-4" />
            <p className="text-gray-400 text-sm">Kamera belum aktif</p>
          </div>
        )}

        {/* STATUS OVERLAYS */}
        {isStreaming && (
          <>
            {/* TOP LEFT */}
            <div className="absolute top-3 left-3 flex flex-col gap-2">
              <div className={`backdrop-blur-lg rounded-xl px-3 py-2 flex items-center gap-2 border ${
                isConnected
                  ? 'bg-green-500/20 border-green-500/40 text-green-300'
                  : 'bg-amber-500/20 border-amber-500/40 text-amber-300'
              }`}>
                {isConnected ? <Wifi className="w-4 h-4" /> : <Activity className="w-4 h-4 animate-spin" />}
                <span className="text-xs font-bold">{isConnected ? 'LIVE' : 'Connecting...'}</span>
              </div>

              {audioEnabled && !micMuted && (
                <div className="backdrop-blur-lg rounded-xl px-3 py-2 bg-blue-500/20 border border-blue-500/40 text-blue-300 flex items-center gap-2">
                  <Mic className="w-4 h-4" />
                  <span className="text-xs font-bold">AUDIO</span>
                </div>
              )}
            </div>

            {/* TOP RIGHT */}
            <div className="absolute top-3 right-3 flex flex-col gap-2 items-end">
              {isAnalyzing && (
                <div className="backdrop-blur-lg rounded-xl px-3 py-2 bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 flex items-center gap-2">
                  <Activity className="w-4 h-4 animate-pulse" />
                  <span className="text-xs font-bold">Sync...</span>
                </div>
              )}
              <div className="backdrop-blur-lg rounded-xl px-3 py-2 bg-black/40 border border-white/20 text-white flex items-center gap-2">
                <Eye className="w-4 h-4" />
                <span className="text-xs font-bold">{activeMonitors} Monitor</span>
                {connectingMonitors > 0 && <span className="text-xs font-bold"> (+{connectingMonitors})</span>}
              </div>
            </div>

            {/* AUDIO LEVEL */}
            {audioEnabled && !micMuted && (
              <div className="absolute bottom-12 left-3 right-3">
                <div className="flex items-center gap-2 bg-black/50 backdrop-blur rounded-xl p-2">
                  <Mic className="w-4 h-4 text-white flex-shrink-0" />
                  <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-100 ${
                        audioLevel > 70 ? 'bg-red-500' : 
                        audioLevel > 40 ? 'bg-yellow-500' : 'bg-green-500'
                      }`}
                      style={{ width: `${audioLevel}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* BABY STATUS */}
            {babyStatus !== 'unknown' && (
              <div className={`absolute bottom-3 left-3 backdrop-blur-lg rounded-xl px-4 py-2 border font-bold ${
                babyStatus === 'sleeping'
                  ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                  : 'bg-amber-500/20 border-amber-500/40 text-amber-300'
              }`}>
                {babyStatus === 'sleeping' ? '😴 Tidur' : '👀 Bangun'}
              </div>
            )}
          </>
        )}
      </div>

      {/* MAIN CONTROLS */}
      <div className="space-y-3">
        {!isStreaming ? (
          <button
            onClick={startCamera}
            className={`w-full py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 ${
              'bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white shadow-lg hover:scale-105 active:scale-95'
            }`}
          >
            <Video className="w-5 h-5" />
            Mulai Streaming {audioEnabled && '+ Audio'}
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={stopCamera}
              className="bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all hover:scale-105 active:scale-95"
            >
              <VideoOff className="w-5 h-5" />
              Stop
            </button>
            <button
              onClick={switchCamera}
              className={`py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all hover:scale-105 ${
                nightMode
                  ? 'bg-slate-700 text-white hover:bg-slate-600'
                  : 'bg-slate-200 text-gray-800 hover:bg-slate-300'
              }`}
            >
              <RotateCcw className="w-5 h-5" />
              Flip
            </button>
          </div>
        )}
      </div>

      {/* MIC TOGGLE */}
      {isStreaming && audioEnabled && (
        <div className="mt-3">
          <button
            onClick={toggleMic}
            className={`w-full py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all ${
              micMuted
                ? 'bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30'
                : 'bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30'
            }`}
          >
            {micMuted ? (
              <>
                <MicOff className="w-5 h-5" />
                <span>Mikrofon Mati</span>
              </>
            ) : (
              <>
                <Mic className="w-5 h-5" />
                <span>Mikrofon Aktif</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* MANUAL STATUS */}
      {isStreaming && (
        <div className="mt-4 space-y-2">
          <p className={`text-xs font-semibold ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>
            👶 Update Status Manual:
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => updateStatus('sleeping')}
              className={`py-3 rounded-xl font-bold transition-all ${
                babyStatus === 'sleeping'
                  ? 'bg-blue-500 text-white shadow-lg'
                  : nightMode
                    ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
              }`}
            >
              😴 Tidur
            </button>
            <button
              onClick={() => updateStatus('awake')}
              className={`py-3 rounded-xl font-bold transition-all ${
                babyStatus === 'awake'
                  ? 'bg-amber-500 text-white shadow-lg'
                  : nightMode
                    ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
              }`}
            >
              👀 Bangun
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// COMPONENT: CONNECTION STATUS
// ============================================
function ConnectionStatus({ nightMode, isConnected, activeMonitors, micMuted, babyStatus }) {
  const stats = [
    { label: 'Server', value: isConnected ? '✓' : '✗', color: isConnected ? 'green' : 'red', icon: <Signal className="w-5 h-5" /> },
    { label: 'Monitor', value: activeMonitors, color: 'indigo', icon: <Users className="w-5 h-5" /> },
    { label: 'Mic', value: micMuted ? '🔇' : '🎙️', color: micMuted ? 'red' : 'green', icon: <Mic className="w-5 h-5" /> },
    { label: 'Status', value: babyStatus === 'sleeping' ? '😴' : '👀', color: babyStatus === 'sleeping' ? 'blue' : 'amber', icon: <Phone className="w-5 h-5" /> }
  ];

  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all mb-6 ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } p-6 shadow-xl`}>
      <h3 className={`font-bold mb-4 text-lg ${nightMode ? 'text-white' : 'text-gray-800'}`}>
        📊 Status Koneksi
      </h3>
      <div className="grid grid-cols-4 gap-3">
        {stats.map((stat, idx) => (
          <StatItemCamera key={idx} {...stat} nightMode={nightMode} />
        ))}
      </div>
    </div>
  );
}

function StatItemCamera({ label, value, color, icon, nightMode }) {
  const colorMap = {
    green: nightMode ? 'bg-green-500/20 border-green-500/40 text-green-400' : 'bg-green-50 border-green-200 text-green-700',
    red: nightMode ? 'bg-red-500/20 border-red-500/40 text-red-400' : 'bg-red-50 border-red-200 text-red-700',
    indigo: nightMode ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-indigo-50 border-indigo-200 text-indigo-700',
    amber: nightMode ? 'bg-amber-500/20 border-amber-500/40 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-700',
    blue: nightMode ? 'bg-blue-500/20 border-blue-500/40 text-blue-400' : 'bg-blue-50 border-blue-200 text-blue-700'
  };

  return (
    <div className={`text-center p-3 rounded-xl border ${colorMap[color]}`}>
      <div className="flex justify-center mb-1 opacity-70">{icon}</div>
      <p className="text-xs font-medium mb-1 opacity-80">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

// ============================================
// COMPONENT: DEBUG PANEL CAMERA
// ============================================
function DebugPanelCamera({ nightMode, debugLogs, setDebugLogs, connectedMonitors, pendingConnectionsRef }) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border p-6 transition-all mb-6 ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } shadow-xl animate-in slide-in-from-bottom duration-300`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className={`font-bold text-lg ${nightMode ? 'text-white' : 'text-gray-800'}`}>
          🔧 Debug Logs
        </h3>
        <button 
          onClick={() => setDebugLogs([])}
          className={`text-xs font-bold px-3 py-1 rounded-lg transition-all ${
            nightMode
              ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
              : 'bg-red-100 text-red-700 hover:bg-red-200'
          }`}
        >
          Clear
        </button>
      </div>
      <div className={`rounded-2xl p-4 max-h-48 overflow-y-auto font-mono text-xs space-y-1 ${
        nightMode ? 'bg-slate-900/50' : 'bg-gray-900/80'
      }`}>
        {debugLogs.map((log, idx) => (
          <div 
            key={idx} 
            className={`py-0.5 ${
              log.type === 'error' ? 'text-red-400' :
              log.type === 'warning' ? 'text-amber-400' :
              log.type === 'success' ? 'text-green-400' :
              'text-gray-400'
            }`}
          >
            <span className={`opacity-50 ${nightMode ? 'text-slate-600' : 'text-gray-600'}`}>
              [{log.time}]
            </span> {log.message}
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div className={`p-2 rounded-lg text-center ${nightMode ? 'bg-slate-700' : 'bg-gray-200'}`}>
          <div className={nightMode ? 'text-slate-400' : 'text-gray-600'}>Monitors</div>
          <div className="font-bold text-lg">{connectedMonitors.size}</div>
        </div>
        <div className={`p-2 rounded-lg text-center ${nightMode ? 'bg-slate-700' : 'bg-gray-200'}`}>
          <div className={nightMode ? 'text-slate-400' : 'text-gray-600'}>Connected</div>
          <div className="font-bold text-lg text-green-500">{Array.from(connectedMonitors.values()).filter(m => m.status === 'connected').length}</div>
        </div>
        <div className={`p-2 rounded-lg text-center ${nightMode ? 'bg-slate-700' : 'bg-gray-200'}`}>
          <div className={nightMode ? 'text-slate-400' : 'text-gray-600'}>Pending</div>
          <div className="font-bold text-lg text-yellow-500">{pendingConnectionsRef.current.size}</div>
        </div>
      </div>
    </div>
  );
}
