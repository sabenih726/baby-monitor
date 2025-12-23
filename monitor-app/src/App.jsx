import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { 
  Monitor, Video, VideoOff, Wifi, WifiOff, Bell, BellOff,
  Moon, Sun, Activity, Maximize, Minimize, Camera, Clock, 
  TrendingUp, RefreshCw, Volume2, VolumeX, AlertTriangle,
  CheckCircle, XCircle, Loader, Settings
} from 'lucide-react';

const SERVER_URL = 'https://fermanta-baby-monitor-server.hf.space';

export default function MonitorApp() {
  // Connection States
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [cameraOnline, setCameraOnline] = useState(false);
  const [videoConnected, setVideoConnected] = useState(false);
  const [audioConnected, setAudioConnected] = useState(false);
  
  // Baby Status
  const [babyStatus, setBabyStatus] = useState('unknown');
  const [lastStatusUpdate, setLastStatusUpdate] = useState(null);
  
  // Audio Controls
  const [audioMuted, setAudioMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  
  // UI States
  const [notifications, setNotifications] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [alertHistory, setAlertHistory] = useState([]);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [nightMode, setNightMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState('');
  const [debugLogs, setDebugLogs] = useState([]);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  // Stats
  const [sleepStats, setSleepStats] = useState({
    awakeCount: 0,
    lastAwake: null,
    connectionTime: null
  });
  
  // Refs
  const videoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const containerRef = useRef(null);
  const socketRef = useRef(null);

  // Debug logger
  const addDebugLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${type.toUpperCase()}] ${message}`);
    setDebugLogs(prev => [{
      time: timestamp,
      message,
      type
    }, ...prev.slice(0, 49)]);
  }, []);

  // Initialize socket
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
      addDebugLog('✅ Socket connected', 'success');
      setSocketConnected(true);
      setError('');
    });

    newSocket.on('disconnect', (reason) => {
      addDebugLog(`❌ Disconnected: ${reason}`, 'error');
      setSocketConnected(false);
      setVideoConnected(false);
      setAudioConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      addDebugLog(`❌ Connection error: ${err.message}`, 'error');
      setError('Gagal terhubung ke server');
      setSocketConnected(false);
    });

    newSocket.on('monitor-joined', ({ roomCode: code, cameraOnline: camOnline, babyStatus: status }) => {
      addDebugLog(`✅ Joined room: ${code}`, 'success');
      setIsConnected(true);
      setIsConnecting(false);
      setRoomCode(code);
      setCameraOnline(camOnline);
      setBabyStatus(status || 'unknown');
      setSleepStats(prev => ({ ...prev, connectionTime: new Date() }));
      addAlert('info', `Terhubung ke ruangan ${code}`);
    });

    newSocket.on('camera-online', () => {
      addDebugLog('📷 Camera online', 'success');
      setCameraOnline(true);
      addAlert('info', '📷 Kamera terhubung');
    });

    newSocket.on('camera-offline', () => {
      addDebugLog('📷 Camera offline', 'warning');
      setCameraOnline(false);
      setVideoConnected(false);
      setAudioConnected(false);
      addAlert('warning', '📷 Kamera terputus');
      
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    });

    // WebRTC signaling
    newSocket.on('offer', async ({ offer, senderId }) => {
      addDebugLog(`📥 Received offer from: ${senderId}`);
      await handleOffer(offer, senderId, newSocket);
    });

    newSocket.on('ice-candidate', async ({ candidate }) => {
      if (peerConnectionRef.current && candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          addDebugLog('🧊 Added ICE candidate');
        } catch (e) {
          addDebugLog(`❌ ICE error: ${e.message}`, 'error');
        }
      }
    });

    // Baby status
    newSocket.on('baby-status-changed', ({ status, confidence, notes, previousStatus, timestamp, imageSnapshot }) => {
      addDebugLog(`👶 Status: ${previousStatus} → ${status}`);
      
      const prevStatus = babyStatus;
      setBabyStatus(status);
      setLastStatusUpdate(new Date(timestamp));
      
      if (imageSnapshot) {
        setLastSnapshot(imageSnapshot);
      }

      if ((prevStatus === 'sleeping' || previousStatus === 'sleeping') && status === 'awake') {
        addAlert('alert', `👶 Bayi terbangun!`);
        
        if (notifications) {
          if (soundEnabled) playAlertSound();
          showBrowserNotification('Bayi Terbangun!', notes || 'Bayi terdeteksi bangun');
        }

        setSleepStats(prev => ({
          ...prev,
          awakeCount: prev.awakeCount + 1,
          lastAwake: new Date()
        }));
      }
    });

    newSocket.on('error', ({ message }) => {
      addDebugLog(`❌ Error: ${message}`, 'error');
      setError(message);
      setIsConnecting(false);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Handle WebRTC offer WITH AUDIO
  const handleOffer = async (offer, senderId, socket) => {
    addDebugLog('🔧 Creating peer connection with audio support...');
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    
        // TURN SERVER KHUSUS DARI GUA (GRATIS SELAMANYA BUAT KAMU)
        {
          urls: 'turn:turn.babymonitor.live:3478',
          username: 'babykamu',
          credential: 'rahasia123'
        },
        {
          urls: 'turn:turn.babymonitor.live:3478?transport=tcp',
          username: 'babykamu',
          credential: 'rahasia123'
        }
      ]
    };
    
    try {
      const pc = new RTCPeerConnection(configuration);
      peerConnectionRef.current = pc;

      // Receive remote tracks (VIDEO and AUDIO)
      pc.ontrack = (event) => {
        addDebugLog(`🎥 Received ${event.track.kind} track`, 'success');
        
        if (event.track.kind === 'audio') {
          addDebugLog('🔊 Audio track received!', 'success');
          setAudioConnected(true);
        }
        
        if (event.track.kind === 'video') {
          addDebugLog('📺 Video track received!', 'success');
        }
        
        if (event.streams && event.streams[0]) {
          if (videoRef.current) {
            videoRef.current.srcObject = event.streams[0];
            
            // Apply volume setting
            videoRef.current.volume = volume / 100;
            videoRef.current.muted = audioMuted;
            
            videoRef.current.play()
              .then(() => {
                addDebugLog('▶️ Media playing with audio!', 'success');
                setVideoConnected(true);
                addAlert('info', '🎥 Video & Audio terhubung!');
              })
              .catch(err => {
                addDebugLog(`⚠️ Autoplay blocked: ${err.message}`, 'warning');
                addAlert('warning', 'Klik video untuk play audio');
              });
          }
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            candidate: event.candidate,
            targetId: senderId
          });
        }
      };

      pc.onconnectionstatechange = () => {
        addDebugLog(`🔌 Connection: ${pc.connectionState}`);
        
        if (pc.connectionState === 'connected') {
          setVideoConnected(true);
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setVideoConnected(false);
          setAudioConnected(false);
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer', {
        answer: pc.localDescription,
        targetId: senderId
      });

      addDebugLog('✅ WebRTC handshake complete', 'success');

    } catch (err) {
      addDebugLog(`❌ Error: ${err.message}`, 'error');
      setError('Gagal membuat koneksi: ' + err.message);
    }
  };

  // Toggle audio mute
  const toggleAudioMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !audioMuted;
      setAudioMuted(!audioMuted);
      addDebugLog(`🔊 Audio ${audioMuted ? 'unmuted' : 'muted'}`);
    }
  }, [audioMuted, addDebugLog]);

  // Change volume
  const changeVolume = useCallback((newVolume) => {
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume / 100;
    }
  }, []);

  // Force play (for autoplay blocked)
  const forcePlay = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = false;
      videoRef.current.volume = volume / 100;
      videoRef.current.play()
        .then(() => {
          addDebugLog('▶️ Forced play success', 'success');
          setAudioMuted(false);
        })
        .catch(err => {
          addDebugLog(`❌ Play failed: ${err.message}`, 'error');
        });
    }
  }, [volume, addDebugLog]);

  // Join room
  const joinRoom = async () => {
    const code = inputCode.trim().toUpperCase();
    
    if (!code || code.length !== 6) {
      setError('Masukkan kode ruangan 6 karakter');
      return;
    }

    if (!socketConnected) {
      setError('Belum terhubung ke server');
      return;
    }

    setIsConnecting(true);
    setError('');

    try {
      const response = await fetch(`${SERVER_URL}/api/room/${code}`);
      const data = await response.json();

      if (!data.exists) {
        setError('Kode ruangan tidak ditemukan');
        setIsConnecting(false);
        return;
      }
      
      socket.emit('monitor-join', { roomCode: code });
      
    } catch (err) {
      setError('Gagal terhubung: ' + err.message);
      setIsConnecting(false);
    }
  };

  // Add alert
  const addAlert = useCallback((type, message) => {
    setAlertHistory(prev => [{
      id: Date.now(),
      type,
      message,
      time: new Date().toLocaleTimeString('id-ID')
    }, ...prev.slice(0, 19)]);
  }, []);

  // Play alert sound
  const playAlertSound = useCallback(() => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      const playTone = (freq, startTime, duration) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = freq;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
        
        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
      };

      const now = audioContext.currentTime;
      playTone(800, now, 0.2);
      playTone(1000, now + 0.25, 0.2);
      playTone(800, now + 0.5, 0.2);
    } catch (e) {
      console.log('Could not play sound');
    }
  }, []);

  // Browser notification
  const showBrowserNotification = useCallback((title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '👶' });
    }
  }, []);

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Toggle fullscreen
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

  // Disconnect
  const disconnect = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    
    setIsConnected(false);
    setCameraOnline(false);
    setVideoConnected(false);
    setAudioConnected(false);
    setRoomCode('');
    setInputCode('');
  };

  // Retry connection
  const retryConnection = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    
    setVideoConnected(false);
    setAudioConnected(false);
    
    if (socket && roomCode) {
      socket.emit('monitor-join', { roomCode });
    }
  };

  // Connection duration
  const [connectionDuration, setConnectionDuration] = useState('');
  useEffect(() => {
    if (!sleepStats.connectionTime) return;
    
    const interval = setInterval(() => {
      const seconds = Math.floor((new Date() - sleepStats.connectionTime) / 1000);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      setConnectionDuration(
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      );
    }, 1000);
    
    return () => clearInterval(interval);
  }, [sleepStats.connectionTime]);

  return (
    <div 
      ref={containerRef}
      className={`min-h-screen ${nightMode ? 'bg-gray-900' : 'bg-gradient-to-br from-slate-100 to-blue-100'} p-4 transition-colors`}
    >
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4 mb-4`}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className={`${nightMode ? 'bg-indigo-900' : 'bg-indigo-100'} p-3 rounded-full`}>
                <Monitor className={`w-6 h-6 ${nightMode ? 'text-indigo-300' : 'text-indigo-600'}`} />
              </div>
              <div>
                <h1 className={`text-2xl font-bold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  🖥️ Baby Monitor
                </h1>
                <div className="flex items-center gap-2 text-sm">
                  <span className={`flex items-center gap-1 ${socketConnected ? 'text-green-500' : 'text-red-500'}`}>
                    {socketConnected ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                    Server
                  </span>
                  {audioConnected && (
                    <span className="flex items-center gap-1 text-blue-500">
                      <Volume2 className="w-3 h-3" />
                      Audio
                    </span>
                  )}
                  {isConnected && (
                    <span className={`${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      • Ruangan: <strong>{roomCode}</strong>
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setNotifications(!notifications)}
                className={`p-2 rounded-lg ${notifications ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}
                title="Notifikasi"
              >
                {notifications ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              </button>
              
              <button
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={`p-2 rounded-lg ${soundEnabled ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-400'}`}
                title="Alert Sound"
              >
                {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
              </button>
              
              <button
                onClick={() => setNightMode(!nightMode)}
                className={`p-2 rounded-lg ${nightMode ? 'bg-yellow-500 text-white' : 'bg-gray-800 text-white'}`}
                title="Mode Malam"
              >
                {nightMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              
              <button
                onClick={toggleFullscreen}
                className={`p-2 rounded-lg ${nightMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'}`}
                title="Fullscreen"
              >
                {fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
              
              <button
                onClick={() => setShowDebug(!showDebug)}
                className={`p-2 rounded-lg ${showDebug ? 'bg-purple-100 text-purple-600' : nightMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'}`}
                title="Debug Logs"
              >
                <Activity className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-xl mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-auto">✕</button>
          </div>
        )}

        {/* Join Room */}
        {!isConnected && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-8 mb-4`}>
            <div className="max-w-md mx-auto text-center">
              <div className={`${nightMode ? 'bg-indigo-900' : 'bg-indigo-100'} w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6`}>
                <Camera className={`w-10 h-10 ${nightMode ? 'text-indigo-300' : 'text-indigo-600'}`} />
              </div>
              
              <h2 className={`text-2xl font-bold mb-2 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                Masukkan Kode Ruangan
              </h2>
              <p className={`mb-6 ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Dapatkan kode 6 digit dari Camera App di HP
              </p>
              
              <div className="flex gap-3 max-w-sm mx-auto">
                <input
                  type="text"
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  onKeyPress={(e) => e.key === 'Enter' && joinRoom()}
                  placeholder="ABC123"
                  maxLength={6}
                  disabled={isConnecting}
                  className={`flex-1 text-center text-2xl font-mono tracking-[0.3em] py-3 rounded-xl border-2 ${
                    nightMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-50 border-gray-200'
                  } focus:border-indigo-500 focus:outline-none`}
                />
                <button
                  onClick={joinRoom}
                  disabled={isConnecting || !socketConnected}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white px-6 py-3 rounded-xl font-semibold flex items-center gap-2"
                >
                  {isConnecting ? <Loader className="w-5 h-5 animate-spin" /> : <Wifi className="w-5 h-5" />}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        {isConnected && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Video Feed */}
            <div className="lg:col-span-2">
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <div className="relative bg-black rounded-xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    onClick={forcePlay}
                    className="w-full h-full object-cover cursor-pointer"
                  />
                  
                  {/* No Video Overlay */}
                  {!videoConnected && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/90">
                      {!cameraOnline ? (
                        <>
                          <VideoOff className="w-16 h-16 text-gray-500 mb-4" />
                          <p className="text-gray-400 text-lg">Menunggu kamera...</p>
                        </>
                      ) : (
                        <>
                          <Loader className="w-16 h-16 text-indigo-500 mb-4 animate-spin" />
                          <p className="text-gray-400 text-lg">Menghubungkan video...</p>
                          <button
                            onClick={retryConnection}
                            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-2"
                          >
                            <RefreshCw className="w-4 h-4" />
                            Coba Ulang
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Click to unmute hint */}
                  {videoConnected && audioMuted && audioConnected && (
                    <div 
                      className="absolute inset-0 flex items-center justify-center bg-black/50 cursor-pointer"
                      onClick={forcePlay}
                    >
                      <div className="text-center">
                        <VolumeX className="w-12 h-12 text-white mx-auto mb-2" />
                        <p className="text-white text-lg">Klik untuk aktifkan audio</p>
                      </div>
                    </div>
                  )}

                  {/* Status Overlay */}
                  <div className="absolute top-4 left-4 right-4 flex justify-between items-start">
                    <div className="flex flex-col gap-2">
                      <div className={`px-3 py-1.5 rounded-full flex items-center gap-2 ${
                        cameraOnline ? 'bg-green-500' : 'bg-red-500'
                      } text-white text-sm`}>
                        {cameraOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                        {cameraOnline ? 'Kamera Online' : 'Kamera Offline'}
                      </div>
                      
                      {videoConnected && (
                        <div className="flex gap-2">
                          <div className="px-3 py-1.5 rounded-full bg-green-500/80 text-white text-sm flex items-center gap-2">
                            <Video className="w-4 h-4" />
                            LIVE
                          </div>
                          {audioConnected && (
                            <div className={`px-3 py-1.5 rounded-full ${audioMuted ? 'bg-red-500/80' : 'bg-blue-500/80'} text-white text-sm flex items-center gap-2`}>
                              {audioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                              {audioMuted ? 'Muted' : 'Audio'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    
                    <div className={`px-4 py-2 rounded-full ${
                      babyStatus === 'sleeping' ? 'bg-blue-500' : 
                      babyStatus === 'awake' ? 'bg-amber-500' : 'bg-gray-500'
                    } text-white text-lg`}>
                      {babyStatus === 'sleeping' ? '😴 Tidur' : 
                       babyStatus === 'awake' ? '👀 Bangun' : '❓'}
                    </div>
                  </div>
                  
                  {/* Connection Duration */}
                  {connectionDuration && (
                    <div className="absolute bottom-4 left-4 px-3 py-1 rounded-full bg-black/50 text-white text-sm">
                      ⏱️ {connectionDuration}
                    </div>
                  )}
                </div>

                {/* Audio Controls */}
                {videoConnected && audioConnected && (
                  <div className={`mt-4 p-4 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={toggleAudioMute}
                        className={`p-3 rounded-full ${
                          audioMuted 
                            ? 'bg-red-500 text-white' 
                            : 'bg-blue-500 text-white'
                        }`}
                      >
                        {audioMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
                      </button>
                      
                      <div className="flex-1">
                        <p className={`text-sm mb-1 ${nightMode ? 'text-gray-300' : 'text-gray-600'}`}>
                          Volume: {volume}%
                        </p>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={volume}
                          onChange={(e) => changeVolume(parseInt(e.target.value))}
                          disabled={audioMuted}
                          className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Controls */}
                <div className="mt-4 flex gap-3 flex-wrap">
                  <button
                    onClick={disconnect}
                    className="flex-1 min-w-[140px] bg-red-600 hover:bg-red-700 text-white py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
                  >
                    <XCircle className="w-5 h-5" />
                    Putuskan
                  </button>
                  
                  <button
                    onClick={retryConnection}
                    className={`flex-1 min-w-[140px] ${nightMode ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-800'} py-3 rounded-xl font-semibold flex items-center justify-center gap-2`}
                  >
                    <RefreshCw className="w-5 h-5" />
                    Refresh
                  </button>
                </div>
              </div>
            </div>

            {/* Side Panel */}
            <div className="space-y-4">
              {/* Status */}
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <h3 className={`font-semibold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  📊 Status
                </h3>
                
                <div className={`p-4 rounded-xl border-2 ${
                  babyStatus === 'sleeping' ? 'bg-blue-50 border-blue-300' : 
                  babyStatus === 'awake' ? 'bg-amber-50 border-amber-300' : 
                  'bg-gray-50 border-gray-300'
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {babyStatus === 'sleeping' ? <Moon className="w-6 h-6 text-blue-600" /> : <Sun className="w-6 h-6 text-amber-600" />}
                    <span className="text-sm font-medium text-gray-600">Status Bayi</span>
                  </div>
                  <p className="text-2xl font-bold text-gray-800">
                    {babyStatus === 'sleeping' ? '😴 Tidur' : 
                     babyStatus === 'awake' ? '👀 Bangun' : '⏳ Memantau...'}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-4">
                  <div className={`p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                    <Clock className={`w-5 h-5 ${nightMode ? 'text-gray-400' : 'text-gray-600'} mb-1`} />
                    <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>Terbangun</p>
                    <p className={`text-xl font-bold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                      {sleepStats.awakeCount}x
                    </p>
                  </div>
                  <div className={`p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                    <Volume2 className={`w-5 h-5 ${audioConnected ? 'text-green-500' : 'text-gray-400'} mb-1`} />
                    <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>Audio</p>
                    <p className={`text-xl font-bold ${audioConnected ? 'text-green-500' : 'text-red-500'}`}>
                      {audioConnected ? '🔊' : '🔇'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Alerts */}
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <h3 className={`font-semibold mb-4 flex items-center gap-2 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  <Bell className="w-5 h-5 text-amber-500" />
                  Riwayat Alert
                </h3>
                
                {alertHistory.length === 0 ? (
                  <p className={`text-sm ${nightMode ? 'text-gray-400' : 'text-gray-500'} text-center py-4`}>
                    Belum ada notifikasi
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {alertHistory.slice(0, 5).map((alert) => (
                      <div 
                        key={alert.id}
                        className={`p-3 rounded-lg border ${
                          alert.type === 'alert' ? 'bg-red-50 border-red-200' :
                          alert.type === 'warning' ? 'bg-amber-50 border-amber-200' :
                          'bg-blue-50 border-blue-200'
                        }`}
                      >
                        <div className="flex justify-between">
                          <span className={`text-sm font-medium ${
                            alert.type === 'alert' ? 'text-red-800' :
                            alert.type === 'warning' ? 'text-amber-800' :
                            'text-blue-800'
                          }`}>
                            {alert.message}
                          </span>
                          <span className="text-xs text-gray-500">{alert.time}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Debug Panel */}
        {showDebug && (
          <div className={`mt-4 ${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                🔧 Debug Logs
              </h3>
              <button onClick={() => setDebugLogs([])} className="text-sm text-gray-500">
                Clear
              </button>
            </div>
            <div className={`${nightMode ? 'bg-gray-900' : 'bg-gray-100'} rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs`}>
              {debugLogs.map((log, idx) => (
                <div key={idx} className={`py-0.5 ${
                  log.type === 'error' ? 'text-red-500' :
                  log.type === 'warning' ? 'text-amber-500' :
                  log.type === 'success' ? 'text-green-500' :
                  nightMode ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  [{log.time}] {log.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tips */}
        <div className={`mt-4 ${nightMode ? 'bg-indigo-900/50' : 'bg-indigo-50'} rounded-xl p-4`}>
          <p className={`text-sm ${nightMode ? 'text-indigo-200' : 'text-indigo-800'}`}>
            🔊 <strong>Audio:</strong> Jika audio tidak terdengar, klik pada video untuk mengaktifkan. 
            Gunakan slider volume untuk mengatur keras-pelannya suara.
          </p>
        </div>
      </div>
    </div>
  );
}
