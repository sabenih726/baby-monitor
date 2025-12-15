import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { 
  Camera, Video, VideoOff, Wifi, WifiOff, 
  Copy, Check, RotateCcw, Moon, Sun, Activity, Battery, Signal,
  Mic, MicOff, Volume2, Settings
} from 'lucide-react';

// Ganti dengan URL Hugging Face Space Anda
const SERVER_URL = 'https://fermanta-baby-monitor-server.hf.space';

export default function CameraApp() {
  // Connection States
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [monitorCount, setMonitorCount] = useState(0);
  const [copied, setCopied] = useState(false);
  
  // Media States
  const [audioEnabled, setAudioEnabled] = useState(true); // Microphone ON by default
  const [micMuted, setMicMuted] = useState(false);
  const [facingMode, setFacingMode] = useState('environment');
  const [audioLevel, setAudioLevel] = useState(0);
  
  // Baby Status
  const [babyStatus, setBabyStatus] = useState('unknown');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  // UI States
  const [nightMode, setNightMode] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  
  // Refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const peerConnections = useRef(new Map());
  const analysisIntervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const audioIntervalRef = useRef(null);

  // Initialize socket connection
  useEffect(() => {
    console.log('Connecting to server...');
    
    const newSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    newSocket.on('connect', () => {
      console.log('✅ Connected to server');
      setSocketConnected(true);
      setError('');
    });

    newSocket.on('disconnect', (reason) => {
      console.log('❌ Disconnected:', reason);
      setSocketConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      console.error('Connection error:', err);
      setError('Gagal terhubung ke server');
      setSocketConnected(false);
    });

    newSocket.on('camera-joined', ({ roomCode }) => {
      setIsConnected(true);
      console.log('✅ Joined room:', roomCode);
    });

    newSocket.on('monitor-connected', async ({ monitorId }) => {
      console.log('📺 Monitor connected:', monitorId);
      setMonitorCount(prev => prev + 1);
      await createPeerConnection(monitorId, newSocket);
    });

    newSocket.on('answer', async ({ answer, senderId }) => {
      console.log('📥 Received answer from:', senderId);
      const pc = peerConnections.current.get(senderId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          console.log('✅ Remote description set');
        } catch (err) {
          console.error('Error setting remote description:', err);
        }
      }
    });

    newSocket.on('ice-candidate', async ({ candidate, senderId }) => {
      const pc = peerConnections.current.get(senderId);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding ICE candidate:', e);
        }
      }
    });

    newSocket.on('error', ({ message }) => {
      setError(message);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Audio level monitoring
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
      
      console.log('🎙️ Audio monitoring started');
    } catch (err) {
      console.error('Error starting audio monitoring:', err);
    }
  }, []);

  // Stop audio monitoring
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
  }, []);

  // Create WebRTC peer connection with audio
  const createPeerConnection = async (monitorId, socket) => {
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceCandidatePoolSize: 10
    };

    console.log('🔧 Creating peer connection for:', monitorId);
    const pc = new RTCPeerConnection(configuration);
    peerConnections.current.set(monitorId, pc);

    // Add ALL tracks (video AND audio)
    if (streamRef.current) {
      const tracks = streamRef.current.getTracks();
      console.log(`📤 Adding ${tracks.length} tracks to peer connection`);
      
      tracks.forEach(track => {
        console.log(`  - Adding ${track.kind} track (enabled: ${track.enabled})`);
        pc.addTrack(track, streamRef.current);
      });
    } else {
      console.error('❌ No stream available!');
    }

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetId: monitorId
        });
      }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
      console.log(`🔌 Connection state [${monitorId}]:`, pc.connectionState);
      
      if (pc.connectionState === 'connected') {
        console.log('✅ WebRTC Connected with audio!');
      }
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        peerConnections.current.delete(monitorId);
        setMonitorCount(prev => Math.max(0, prev - 1));
      }
    };

    // Create offer with audio
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      
      await pc.setLocalDescription(offer);
      
      console.log('📤 Sending offer with audio to:', monitorId);
      socket.emit('offer', {
        offer: pc.localDescription,
        targetId: monitorId
      });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  };

  // Toggle microphone mute
  const toggleMic = useCallback(() => {
    if (streamRef.current) {
      const audioTracks = streamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = micMuted; // Toggle: if muted, enable; if enabled, mute
        console.log(`🎙️ Microphone ${track.enabled ? 'unmuted' : 'muted'}`);
      });
      setMicMuted(!micMuted);
    }
  }, [micMuted]);

  // Generate room code
  const generateRoom = async () => {
    try {
      setError('');
      const response = await fetch(`${SERVER_URL}/api/generate-room`);
      const data = await response.json();
      setRoomCode(data.roomCode);
      console.log('🔑 Room code generated:', data.roomCode);
    } catch (err) {
      console.error('Error generating room:', err);
      setError('Gagal generate room. Periksa koneksi internet.');
    }
  };

  // Start camera WITH AUDIO
  const startCamera = async () => {
    try {
      setError('');
      console.log('📷 Starting camera with audio...');
      
      // Request video AND audio
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
      
      console.log('📋 Media constraints:', constraints);
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Log tracks
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();
      console.log(`✅ Got ${videoTracks.length} video track(s)`);
      console.log(`✅ Got ${audioTracks.length} audio track(s)`);
      
      if (audioTracks.length > 0) {
        console.log('🎙️ Audio track settings:', audioTracks[0].getSettings());
        // Start audio level monitoring
        startAudioMonitoring(stream);
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      streamRef.current = stream;
      setIsStreaming(true);

      // Join room
      if (socket && roomCode) {
        socket.emit('camera-join', { roomCode });
      }

      // Start auto-analysis
      startAnalysis();

    } catch (err) {
      console.error('Error starting camera:', err);
      if (err.name === 'NotAllowedError') {
        setError('Izin kamera/mikrofon ditolak. Silakan izinkan akses di pengaturan browser.');
      } else if (err.name === 'NotFoundError') {
        setError('Kamera atau mikrofon tidak ditemukan.');
      } else {
        setError('Gagal mengakses kamera: ' + err.message);
      }
    }
  };

  // Stop camera
  const stopCamera = () => {
    console.log('🛑 Stopping camera...');
    
    // Stop audio monitoring
    stopAudioMonitoring();
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log(`  - Stopped ${track.kind} track`);
      });
      streamRef.current = null;
    }
    
    // Close all peer connections
    peerConnections.current.forEach((pc, id) => {
      pc.close();
      console.log(`  - Closed peer connection: ${id}`);
    });
    peerConnections.current.clear();
    
    setIsStreaming(false);
    setIsConnected(false);
    setMonitorCount(0);
    setMicMuted(false);
    
    // Stop analysis
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
    }
  };

  // Switch camera
  const switchCamera = async () => {
    const newFacing = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newFacing);
    
    if (isStreaming) {
      stopCamera();
      setTimeout(() => startCamera(), 500);
    }
  };

  // Copy room code
  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Analyze baby status
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

    // Send frame to monitors
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

  // Start periodic analysis
  const startAnalysis = () => {
    setTimeout(analyzeFrame, 2000);
    analysisIntervalRef.current = setInterval(analyzeFrame, 15000);
  };

  // Manual status update
  const updateStatus = (status) => {
    setBabyStatus(status);
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

  return (
    <div className={`min-h-screen ${nightMode ? 'bg-gray-900' : 'bg-gradient-to-br from-indigo-500 to-purple-600'} p-4 transition-colors`}>
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4 mb-4`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`${nightMode ? 'bg-indigo-900' : 'bg-indigo-100'} p-2 rounded-full`}>
                <Camera className={`w-6 h-6 ${nightMode ? 'text-indigo-300' : 'text-indigo-600'}`} />
              </div>
              <div>
                <h1 className={`text-xl font-bold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  📷 Kamera Bayi
                </h1>
                <div className="flex items-center gap-2 text-xs">
                  <span className={`flex items-center gap-1 ${socketConnected ? 'text-green-500' : 'text-red-500'}`}>
                    {socketConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                    {socketConnected ? 'Terhubung' : 'Offline'}
                  </span>
                  {isStreaming && audioEnabled && (
                    <span className="flex items-center gap-1 text-green-500">
                      <Mic className="w-3 h-3" />
                      Audio
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-2 rounded-full ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}
              >
                <Settings className={`w-5 h-5 ${nightMode ? 'text-gray-300' : 'text-gray-600'}`} />
              </button>
              <button
                onClick={() => setNightMode(!nightMode)}
                className={`p-2 rounded-full ${nightMode ? 'bg-yellow-500' : 'bg-gray-800'}`}
              >
                {nightMode ? <Sun className="w-5 h-5 text-white" /> : <Moon className="w-5 h-5 text-white" />}
              </button>
            </div>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && !isStreaming && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4 mb-4`}>
            <h3 className={`font-semibold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              ⚙️ Pengaturan Streaming
            </h3>
            
            {/* Audio Toggle */}
            <div className="flex items-center justify-between py-3 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <Mic className={`w-5 h-5 ${audioEnabled ? 'text-green-500' : 'text-gray-400'}`} />
                <div>
                  <p className={`font-medium ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                    Mikrofon
                  </p>
                  <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    Streaming suara ke monitor
                  </p>
                </div>
              </div>
              <button
                onClick={() => setAudioEnabled(!audioEnabled)}
                className={`relative w-12 h-6 rounded-full transition-colors ${
                  audioEnabled ? 'bg-green-500' : 'bg-gray-300'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  audioEnabled ? 'translate-x-6' : 'translate-x-0'
                }`} />
              </button>
            </div>
            
            {/* Camera Selection */}
            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <RotateCcw className={`w-5 h-5 ${nightMode ? 'text-gray-400' : 'text-gray-600'}`} />
                <div>
                  <p className={`font-medium ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                    Kamera
                  </p>
                  <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {facingMode === 'environment' ? 'Kamera belakang' : 'Kamera depan'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setFacingMode(f => f === 'environment' ? 'user' : 'environment')}
                className={`px-3 py-1 rounded-lg ${nightMode ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-800'}`}
              >
                Ganti
              </button>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-xl mb-4 flex items-center justify-between">
            <span className="text-sm">{error}</span>
            <button onClick={() => setError('')} className="text-red-700 font-bold">✕</button>
          </div>
        )}

        {/* Room Code Section */}
        {!isStreaming && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-6 mb-4`}>
            <h2 className={`text-lg font-semibold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              🔗 Kode Ruangan
            </h2>
            
            {!roomCode ? (
              <button
                onClick={generateRoom}
                disabled={!socketConnected}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white py-3 rounded-xl font-semibold transition-colors"
              >
                Generate Kode Ruangan
              </button>
            ) : (
              <div className="space-y-4">
                <div className={`${nightMode ? 'bg-gray-700' : 'bg-gray-100'} p-4 rounded-xl flex items-center justify-between`}>
                  <span className={`text-3xl font-mono font-bold tracking-widest ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                    {roomCode}
                  </span>
                  <button
                    onClick={copyRoomCode}
                    className={`p-2 rounded-lg ${copied ? 'bg-green-500' : 'bg-indigo-600'} text-white transition-colors`}
                  >
                    {copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                  </button>
                </div>
                <p className={`text-sm ${nightMode ? 'text-gray-400' : 'text-gray-600'} text-center`}>
                  Bagikan kode ini ke Monitor App di PC/Laptop
                </p>
              </div>
            )}
          </div>
        )}

        {/* Camera Preview */}
        <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4 mb-4`}>
          <div className="relative bg-black rounded-xl overflow-hidden mb-4" style={{ aspectRatio: '16/9' }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted // Muted locally to prevent feedback
              className={`w-full h-full object-cover ${nightMode ? 'brightness-125' : ''}`}
            />
            
            {!isStreaming && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                <VideoOff className="w-16 h-16 text-gray-500" />
              </div>
            )}

            {/* Status Overlay */}
            {isStreaming && (
              <>
                {/* Top Bar */}
                <div className="absolute top-2 left-2 right-2 flex justify-between items-start">
                  <div className="flex flex-col gap-1">
                    <div className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1 ${
                      isConnected ? 'bg-green-500' : 'bg-amber-500'
                    } text-white`}>
                      {isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                      {isConnected ? 'Live' : 'Menunggu...'}
                    </div>
                    
                    {/* Audio indicator */}
                    {audioEnabled && !micMuted && (
                      <div className="px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1 bg-blue-500 text-white">
                        <Mic className="w-3 h-3" />
                        Audio ON
                      </div>
                    )}
                  </div>
                  
                  <div className="flex flex-col gap-1 items-end">
                    {isAnalyzing && (
                      <div className="bg-indigo-600 text-white px-3 py-1 rounded-full text-xs flex items-center gap-1">
                        <Activity className="w-3 h-3 animate-pulse" />
                        Sync...
                      </div>
                    )}
                    <div className="bg-black/50 text-white px-3 py-1 rounded-full text-xs">
                      👁️ {monitorCount} Monitor
                    </div>
                  </div>
                </div>

                {/* Audio Level Indicator */}
                {audioEnabled && !micMuted && (
                  <div className="absolute bottom-12 left-2 right-2">
                    <div className="flex items-center gap-2 bg-black/50 rounded-lg p-2">
                      <Mic className="w-4 h-4 text-white" />
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

                {/* Baby Status */}
                {babyStatus !== 'unknown' && (
                  <div className={`absolute bottom-2 left-2 px-3 py-2 rounded-lg ${
                    babyStatus === 'sleeping' ? 'bg-blue-500' : 'bg-amber-500'
                  } text-white`}>
                    {babyStatus === 'sleeping' ? '😴 Tidur' : '👀 Bangun'}
                  </div>
                )}
              </>
            )}
          </div>

          <canvas ref={canvasRef} className="hidden" />

          {/* Main Controls */}
          <div className="grid grid-cols-2 gap-3">
            {!isStreaming ? (
              <button
                onClick={startCamera}
                disabled={!roomCode || !socketConnected}
                className="col-span-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                <Video className="w-5 h-5" />
                Mulai Streaming {audioEnabled && '+ Audio 🎙️'}
              </button>
            ) : (
              <>
                <button
                  onClick={stopCamera}
                  className="bg-red-600 hover:bg-red-700 text-white py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors"
                >
                  <VideoOff className="w-5 h-5" />
                  Stop
                </button>
                <button
                  onClick={switchCamera}
                  className={`${nightMode ? 'bg-gray-700' : 'bg-gray-200'} ${nightMode ? 'text-white' : 'text-gray-800'} py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors`}
                >
                  <RotateCcw className="w-5 h-5" />
                  Flip
                </button>
              </>
            )}
          </div>

          {/* Audio Controls (when streaming) */}
          {isStreaming && audioEnabled && (
            <div className="mt-3">
              <button
                onClick={toggleMic}
                className={`w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors ${
                  micMuted 
                    ? 'bg-red-100 text-red-600 hover:bg-red-200' 
                    : 'bg-green-100 text-green-600 hover:bg-green-200'
                }`}
              >
                {micMuted ? (
                  <>
                    <MicOff className="w-5 h-5" />
                    Mikrofon Mati - Klik untuk Aktifkan
                  </>
                ) : (
                  <>
                    <Mic className="w-5 h-5" />
                    Mikrofon Aktif - Klik untuk Matikan
                  </>
                )}
              </button>
            </div>
          )}

          {/* Manual Status Buttons */}
          {isStreaming && (
            <div className="mt-4">
              <p className={`text-sm mb-2 ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Update Status Manual:
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => updateStatus('sleeping')}
                  className={`py-2 rounded-xl font-medium transition-colors ${
                    babyStatus === 'sleeping' 
                      ? 'bg-blue-600 text-white' 
                      : nightMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  😴 Tidur
                </button>
                <button
                  onClick={() => updateStatus('awake')}
                  className={`py-2 rounded-xl font-medium transition-colors ${
                    babyStatus === 'awake' 
                      ? 'bg-amber-600 text-white' 
                      : nightMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  👀 Bangun
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Connection Status */}
        {isStreaming && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
            <h3 className={`font-semibold mb-3 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              📊 Status Koneksi
            </h3>
            <div className="grid grid-cols-4 gap-2">
              <div className={`text-center p-2 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Signal className={`w-5 h-5 mx-auto mb-1 ${isConnected ? 'text-green-500' : 'text-red-500'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Server</p>
                <p className={`font-semibold text-sm ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  {isConnected ? '✓' : '✗'}
                </p>
              </div>
              <div className={`text-center p-2 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Activity className={`w-5 h-5 mx-auto mb-1 ${nightMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Monitor</p>
                <p className={`font-semibold text-sm ${nightMode ? 'text-white' : 'text-gray-800'}`}>{monitorCount}</p>
              </div>
              <div className={`text-center p-2 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Mic className={`w-5 h-5 mx-auto mb-1 ${!micMuted ? 'text-green-500' : 'text-red-500'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Mic</p>
                <p className={`font-semibold text-sm ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  {!micMuted ? '🎙️' : '🔇'}
                </p>
              </div>
              <div className={`text-center p-2 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Battery className={`w-5 h-5 mx-auto mb-1 ${nightMode ? 'text-green-400' : 'text-green-600'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Status</p>
                <p className={`font-semibold text-sm ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  {babyStatus === 'sleeping' ? '😴' : babyStatus === 'awake' ? '👀' : '❓'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Tips */}
        <div className={`mt-4 ${nightMode ? 'bg-blue-900/50' : 'bg-blue-50'} rounded-xl p-4`}>
          <p className={`text-sm ${nightMode ? 'text-blue-200' : 'text-blue-800'}`}>
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
