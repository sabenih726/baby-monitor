import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { 
  Camera, Video, VideoOff, Wifi, WifiOff, 
  Copy, Check, Volume2, VolumeX, RotateCcw,
  Moon, Sun, Activity, Battery, Signal
} from 'lucide-react';

const SERVER_URL = 'http://YOUR_SERVER_IP:3001'; // Ganti dengan IP server Anda

export default function CameraApp() {
  const [socket, setSocket] = useState(null);
  const [roomCode, setRoomCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [monitorCount, setMonitorCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [babyStatus, setBabyStatus] = useState('unknown');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [facingMode, setFacingMode] = useState('environment');
  const [nightMode, setNightMode] = useState(false);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const peerConnections = useRef(new Map());
  const analysisIntervalRef = useRef(null);

  // Initialize socket connection
  useEffect(() => {
    const newSocket = io(SERVER_URL);
    
    newSocket.on('connect', () => {
      console.log('Connected to server');
    });

    newSocket.on('camera-joined', ({ roomCode }) => {
      setIsConnected(true);
      console.log('Joined room:', roomCode);
    });

    newSocket.on('monitor-connected', async ({ monitorId }) => {
      console.log('Monitor connected:', monitorId);
      setMonitorCount(prev => prev + 1);
      
      // Create peer connection for this monitor
      await createPeerConnection(monitorId, newSocket);
    });

    newSocket.on('answer', async ({ answer, senderId }) => {
      const pc = peerConnections.current.get(senderId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    newSocket.on('ice-candidate', async ({ candidate, senderId }) => {
      const pc = peerConnections.current.get(senderId);
      if (pc && candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    newSocket.on('error', ({ message }) => {
      alert(message);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Create WebRTC peer connection
  const createPeerConnection = async (monitorId, socket) => {
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(configuration);
    peerConnections.current.set(monitorId, pc);

    // Add local stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, streamRef.current);
      });
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetId: monitorId
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        peerConnections.current.delete(monitorId);
        setMonitorCount(prev => Math.max(0, prev - 1));
      }
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('offer', {
      offer: offer,
      targetId: monitorId
    });
  };

  // Generate room code
  const generateRoom = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/generate-room`);
      const data = await response.json();
      setRoomCode(data.roomCode);
    } catch (err) {
      console.error('Error generating room:', err);
      alert('Gagal generate room code. Pastikan server berjalan.');
    }
  };

  // Start camera and join room
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: audioEnabled
      });

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
      alert('Tidak dapat mengakses kamera. Pastikan izin diberikan.');
    }
  };

  // Stop camera
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Close all peer connections
    peerConnections.current.forEach(pc => pc.close());
    peerConnections.current.clear();
    
    setIsStreaming(false);
    setIsConnected(false);
    setMonitorCount(0);
    
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

  // Analyze baby status using Claude API
  const analyzeFrame = async () => {
    if (!videoRef.current || !canvasRef.current || !socket) return;

    setIsAnalyzing(true);
    
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    
    // Apply night mode filter if enabled
    if (nightMode) {
      ctx.filter = 'brightness(1.5) contrast(1.2)';
    }
    ctx.drawImage(video, 0, 0);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.7);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'YOUR_ANTHROPIC_API_KEY', // Ganti dengan API key Anda
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageData.split(',')[1]
                }
              },
              {
                type: 'text',
                text: `Analisis gambar bayi ini. Tentukan:
                1. Apakah bayi sedang tidur atau bangun
                2. Posisi tidur (telentang, tengkurap, miring)
                3. Apakah ada yang perlu diperhatikan
                
                Jawab HANYA dengan format JSON:
                {"status": "sleeping" atau "awake", "confidence": 0-100, "position": "posisi", "notes": "catatan singkat", "alert": true/false}`
              }
            ]
          }]
        })
      });

      const data = await response.json();
      const textContent = data.content?.find(item => item.type === 'text')?.text || '';
      const cleanText = textContent.replace(/```json|```/g, '').trim();
      const result = JSON.parse(cleanText);

      setBabyStatus(result.status);

      // Send status to monitors
      socket.emit('baby-status-update', {
        roomCode,
        status: result.status,
        confidence: result.confidence,
        notes: result.notes,
        position: result.position,
        alert: result.alert,
        imageData: imageData
      });

    } catch (err) {
      console.error('Error analyzing:', err);
    }

    setIsAnalyzing(false);
  };

  // Start periodic analysis
  const startAnalysis = () => {
    // Analyze immediately
    setTimeout(analyzeFrame, 2000);
    
    // Then every 15 seconds
    analysisIntervalRef.current = setInterval(analyzeFrame, 15000);
  };

  return (
    <div className={`min-h-screen ${nightMode ? 'bg-gray-900' : 'bg-gradient-to-br from-indigo-500 to-purple-600'} p-4`}>
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
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Letakkan di kamar bayi
                </p>
              </div>
            </div>
            
            {/* Night Mode Toggle */}
            <button
              onClick={() => setNightMode(!nightMode)}
              className={`p-2 rounded-full ${nightMode ? 'bg-yellow-500' : 'bg-gray-800'}`}
            >
              {nightMode ? <Sun className="w-5 h-5 text-white" /> : <Moon className="w-5 h-5 text-white" />}
            </button>
          </div>
        </div>

        {/* Room Code Section */}
        {!isStreaming && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-6 mb-4`}>
            <h2 className={`text-lg font-semibold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              🔗 Kode Ruangan
            </h2>
            
            {!roomCode ? (
              <button
                onClick={generateRoom}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-semibold"
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
                    className={`p-2 rounded-lg ${copied ? 'bg-green-500' : 'bg-indigo-600'} text-white`}
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
              muted
              className={`w-full h-full object-cover ${nightMode ? 'brightness-150' : ''}`}
            />
            
            {!isStreaming && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                <VideoOff className="w-16 h-16 text-gray-500" />
              </div>
            )}

            {/* Status Overlay */}
            {isStreaming && (
              <div className="absolute top-2 left-2 right-2 flex justify-between">
                <div className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1 ${
                  isConnected ? 'bg-green-500' : 'bg-red-500'
                } text-white`}>
                  {isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                  {isConnected ? 'Terhubung' : 'Terputus'}
                </div>
                
                <div className="flex gap-2">
                  {isAnalyzing && (
                    <div className="bg-indigo-600 text-white px-3 py-1 rounded-full text-xs flex items-center gap-1">
                      <Activity className="w-3 h-3 animate-pulse" />
                      Analisis...
                    </div>
                  )}
                  <div className="bg-black/50 text-white px-3 py-1 rounded-full text-xs">
                    👁️ {monitorCount} Monitor
                  </div>
                </div>
              </div>
            )}

            {/* Baby Status */}
            {isStreaming && babyStatus !== 'unknown' && (
              <div className={`absolute bottom-2 left-2 px-3 py-2 rounded-lg ${
                babyStatus === 'sleeping' ? 'bg-blue-500' : 'bg-amber-500'
              } text-white`}>
                {babyStatus === 'sleeping' ? '😴 Tidur' : '👀 Bangun'}
              </div>
            )}
          </div>

          <canvas ref={canvasRef} className="hidden" />

          {/* Controls */}
          <div className="grid grid-cols-2 gap-3">
            {!isStreaming ? (
              <button
                onClick={startCamera}
                disabled={!roomCode}
                className="col-span-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
              >
                <Video className="w-5 h-5" />
                Mulai Streaming
              </button>
            ) : (
              <>
                <button
                  onClick={stopCamera}
                  className="bg-red-600 hover:bg-red-700 text-white py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
                >
                  <VideoOff className="w-5 h-5" />
                  Stop
                </button>
                <button
                  onClick={switchCamera}
                  className="bg-gray-600 hover:bg-gray-700 text-white py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
                >
                  <RotateCcw className="w-5 h-5" />
                  Flip
                </button>
              </>
            )}
          </div>
        </div>

        {/* Connection Status */}
        {isStreaming && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
            <h3 className={`font-semibold mb-3 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
              📊 Status Koneksi
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div className={`text-center p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Signal className={`w-6 h-6 mx-auto mb-1 ${isConnected ? 'text-green-500' : 'text-red-500'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Server</p>
                <p className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  {isConnected ? 'OK' : 'DC'}
                </p>
              </div>
              <div className={`text-center p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Activity className={`w-6 h-6 mx-auto mb-1 ${nightMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Monitor</p>
                <p className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>{monitorCount}</p>
              </div>
              <div className={`text-center p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <Battery className={`w-6 h-6 mx-auto mb-1 ${nightMode ? 'text-green-400' : 'text-green-600'}`} />
                <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>Status</p>
                <p className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  {babyStatus === 'sleeping' ? '😴' : babyStatus === 'awake' ? '👀' : '❓'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Tips */}
        <div className={`mt-4 ${nightMode ? 'bg-blue-900/50' : 'bg-blue-50'} rounded-xl p-4`}>
          <p className={`text-sm ${nightMode ? 'text-blue-200' : 'text-blue-800'}`}>
            💡 <strong>Tips:</strong> Pastikan HP dalam posisi stabil dan terhubung ke charger untuk monitoring jangka panjang.
          </p>
        </div>
      </div>
    </div>
  );
}
