import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { 
  Monitor, Video, VideoOff, Wifi, WifiOff, Bell, BellOff,
  Moon, Sun, Activity, Maximize, Minimize, Camera, Clock, 
  TrendingUp, RefreshCw, Volume2, VolumeX, AlertTriangle,
  CheckCircle, XCircle, Loader, Settings, Zap, Heart
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
        {
          urls: "stun:stun.relay.metered.ca:80",
        },
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
      peerConnectionRef.current = pc;

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

  const toggleAudioMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !audioMuted;
      setAudioMuted(!audioMuted);
      addDebugLog(`🔊 Audio ${audioMuted ? 'unmuted' : 'muted'}`);
    }
  }, [audioMuted, addDebugLog]);

  const changeVolume = useCallback((newVolume) => {
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume / 100;
    }
  }, []);

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

  const addAlert = useCallback((type, message) => {
    setAlertHistory(prev => [{
      id: Date.now(),
      type,
      message,
      time: new Date().toLocaleTimeString('id-ID')
    }, ...prev.slice(0, 19)]);
  }, []);

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

  const showBrowserNotification = useCallback((title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '👶' });
    }
  }, []);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

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

  // ============================================
  // RENDER - NEW DESIGN
  // ============================================

  return (
    <div 
      ref={containerRef}
      className={`min-h-screen transition-all duration-500 ${
        nightMode 
          ? 'bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800' 
          : 'bg-gradient-to-br from-blue-50 via-white to-purple-50'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 py-6">
        
        {/* ============ HEADER ============ */}
        <Header 
          nightMode={nightMode}
          socketConnected={socketConnected}
          audioConnected={audioConnected}
          roomCode={roomCode}
          isConnected={isConnected}
          notifications={notifications}
          setNotifications={setNotifications}
          soundEnabled={soundEnabled}
          setSoundEnabled={setSoundEnabled}
          nightMode={nightMode}
          setNightMode={setNightMode}
          fullscreen={fullscreen}
          toggleFullscreen={toggleFullscreen}
          showDebug={showDebug}
          setShowDebug={setShowDebug}
        />

        {/* ============ ERROR BANNER ============ */}
        {error && (
          <div className={`mb-4 backdrop-blur-lg rounded-2xl border-l-4 border-red-500 ${
            nightMode 
              ? 'bg-red-500/10' 
              : 'bg-red-50/80'
          } px-6 py-4 flex items-center gap-3 animate-in slide-in-from-top duration-300`}>
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
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
        )}

        {/* ============ JOIN ROOM SCREEN ============ */}
        {!isConnected ? (
          <JoinRoomScreen 
            nightMode={nightMode}
            inputCode={inputCode}
            setInputCode={setInputCode}
            isConnecting={isConnecting}
            socketConnected={socketConnected}
            joinRoom={joinRoom}
          />
        ) : (
          /* ============ CONNECTED VIEW ============ */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
            
            {/* ============ VIDEO SECTION ============ */}
            <VideoSection 
              nightMode={nightMode}
              videoRef={videoRef}
              videoConnected={videoConnected}
              cameraOnline={cameraOnline}
              babyStatus={babyStatus}
              connectionDuration={connectionDuration}
              audioMuted={audioMuted}
              audioConnected={audioConnected}
              forcePlay={forcePlay}
              retryConnection={retryConnection}
              toggleAudioMute={toggleAudioMute}
              volume={volume}
              changeVolume={changeVolume}
              disconnect={disconnect}
            />

            {/* ============ SIDE PANEL ============ */}
            <SidePanel 
              nightMode={nightMode}
              babyStatus={babyStatus}
              audioConnected={audioConnected}
              sleepStats={sleepStats}
              alertHistory={alertHistory}
            />
          </div>
        )}

        {/* ============ DEBUG PANEL ============ */}
        {showDebug && (
          <DebugPanel 
            nightMode={nightMode}
            debugLogs={debugLogs}
            setDebugLogs={setDebugLogs}
          />
        )}

        {/* ============ INFO TIP ============ */}
        <div className={`mt-6 backdrop-blur-xl rounded-2xl border ${
          nightMode
            ? 'bg-indigo-500/10 border-indigo-500/30'
            : 'bg-indigo-50/80 border-indigo-200'
        } p-4`}>
          <p className={`text-sm ${nightMode ? 'text-indigo-200' : 'text-indigo-700'}`}>
            💡 <strong>Pro Tip:</strong> Jika audio tidak terdengar, klik pada video untuk mengaktifkan. 
            Gunakan slider volume untuk mengatur keras-pelannya suara.
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: HEADER (NEW DESIGN)
// ============================================
function Header({ 
  nightMode, socketConnected, audioConnected, roomCode, isConnected,
  notifications, setNotifications, soundEnabled, setSoundEnabled,
  setNightMode, fullscreen, toggleFullscreen, showDebug, setShowDebug 
}) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all duration-300 ${
      nightMode
        ? 'bg-gradient-to-r from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-r from-white/50 to-blue-50/50 border-white/60'
    } p-4 mb-6 shadow-lg hover:shadow-xl`}>
      <div className="flex items-center justify-between flex-wrap gap-4">
        
        {/* LOGO & TITLE */}
        <div className="flex items-center gap-4">
          <div className={`relative group rounded-2xl p-3 transition-all ${
            nightMode
              ? 'bg-gradient-to-br from-indigo-600 to-purple-600'
              : 'bg-gradient-to-br from-indigo-500 to-purple-500'
          } shadow-lg hover:shadow-xl hover:scale-105`}>
            <Monitor className="w-6 h-6 text-white" />
            <div className="absolute inset-0 rounded-2xl bg-white opacity-0 group-hover:opacity-20 transition-opacity" />
          </div>
          
          <div>
            <h1 className={`text-3xl font-bold bg-clip-text bg-gradient-to-r ${
              nightMode
                ? 'from-indigo-300 via-purple-300 to-pink-300 text-transparent'
                : 'from-indigo-600 via-purple-600 to-pink-600 text-transparent'
            }`}>
              Baby Monitor
            </h1>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <StatusBadge 
                icon={<CheckCircle className="w-3 h-3" />}
                label="Server"
                isActive={socketConnected}
                nightMode={nightMode}
              />
              {audioConnected && (
                <StatusBadge 
                  icon={<Volume2 className="w-3 h-3" />}
                  label="Audio"
                  isActive={true}
                  nightMode={nightMode}
                />
              )}
              {isConnected && (
                <span className={`text-xs font-mono px-3 py-1 rounded-full ${
                  nightMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-700'
                }`}>
                  #{roomCode}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-2 flex-wrap">
          <ControlButton 
            icon={notifications ? <Bell /> : <BellOff />}
            isActive={notifications}
            onClick={() => setNotifications(!notifications)}
            title="Notifikasi"
            nightMode={nightMode}
          />
          <ControlButton 
            icon={soundEnabled ? <Volume2 /> : <VolumeX />}
            isActive={soundEnabled}
            onClick={() => setSoundEnabled(!soundEnabled)}
            title="Alert Sound"
            nightMode={nightMode}
          />
          <ControlButton 
            icon={nightMode ? <Sun /> : <Moon />}
            isActive={nightMode}
            onClick={() => setNightMode(!nightMode)}
            title="Dark Mode"
            nightMode={nightMode}
          />
          <ControlButton 
            icon={fullscreen ? <Minimize /> : <Maximize />}
            onClick={toggleFullscreen}
            title="Fullscreen"
            nightMode={nightMode}
          />
          <ControlButton 
            icon={<Activity />}
            isActive={showDebug}
            onClick={() => setShowDebug(!showDebug)}
            title="Debug"
            nightMode={nightMode}
          />
        </div>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: STATUS BADGE
// ============================================
function StatusBadge({ icon, label, isActive, nightMode }) {
  return (
    <span className={`text-xs font-medium flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all ${
      isActive
        ? nightMode
          ? 'bg-green-500/30 text-green-300'
          : 'bg-green-100 text-green-700'
        : nightMode
          ? 'bg-red-500/30 text-red-300'
          : 'bg-red-100 text-red-700'
    }`}>
      {icon}
      {label}
    </span>
  );
}

// ============================================
// COMPONENT: CONTROL BUTTON
// ============================================
function ControlButton({ icon, isActive, onClick, title, nightMode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-2.5 rounded-xl transition-all duration-200 hover:scale-110 ${
        isActive
          ? nightMode
            ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white shadow-lg'
            : 'bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-lg'
          : nightMode
            ? 'bg-slate-700/50 text-slate-300 hover:bg-slate-600/50'
            : 'bg-white/50 text-slate-600 hover:bg-white/70'
      }`}
    >
      {icon}
    </button>
  );
}

// ============================================
// COMPONENT: JOIN ROOM SCREEN
// ============================================
function JoinRoomScreen({ 
  nightMode, inputCode, setInputCode, isConnecting, 
  socketConnected, joinRoom 
}) {
  return (
    <div className={`backdrop-blur-xl rounded-3xl border transition-all ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } p-12 shadow-xl`}>
      <div className="max-w-sm mx-auto text-center space-y-8 animate-in fade-in duration-500">
        
        {/* ICON */}
        <div className={`relative mx-auto w-24 h-24 rounded-3xl ${
          nightMode
            ? 'bg-gradient-to-br from-indigo-600 to-purple-600'
            : 'bg-gradient-to-br from-indigo-500 to-purple-500'
        } flex items-center justify-center shadow-2xl hover:scale-110 transition-transform`}>
          <Camera className="w-12 h-12 text-white" />
          <div className="absolute inset-0 rounded-3xl bg-white/20 animate-pulse" />
        </div>

        {/* TITLE */}
        <div>
          <h2 className={`text-4xl font-bold mb-3 ${
            nightMode ? 'text-white' : 'text-gray-800'
          }`}>
            Masukkan Kode
          </h2>
          <p className={`text-base ${
            nightMode ? 'text-slate-400' : 'text-gray-600'
          }`}>
            Ambil kode 6 digit dari Camera App untuk memulai memantau
          </p>
        </div>

        {/* INPUT */}
        <div className="space-y-4">
          <input
            type="text"
            value={inputCode}
            onChange={(e) => setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onKeyPress={(e) => e.key === 'Enter' && joinRoom()}
            placeholder="ABC123"
            maxLength={6}
            disabled={isConnecting}
            className={`w-full text-center text-4xl font-mono tracking-[0.5em] font-bold py-4 rounded-2xl border-2 transition-all ${
              nightMode
                ? 'bg-slate-700/50 border-slate-600 text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30'
                : 'bg-white/50 border-blue-200 text-gray-800 placeholder-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30'
            } outline-none`}
          />

          {/* BUTTON */}
          <button
            onClick={joinRoom}
            disabled={isConnecting || !socketConnected}
            className={`w-full py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 ${
              isConnecting || !socketConnected
                ? 'bg-gray-400 text-gray-600 cursor-not-allowed'
                : 'bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white shadow-lg hover:shadow-xl hover:scale-105 active:scale-95'
            }`}
          >
            {isConnecting ? (
              <>
                <Loader className="w-5 h-5 animate-spin" />
                Menghubungkan...
              </>
            ) : (
              <>
                <Wifi className="w-5 h-5" />
                Hubungkan Sekarang
              </>
            )}
          </button>

          {!socketConnected && (
            <p className="text-sm text-red-500 flex items-center gap-2 justify-center">
              <AlertTriangle className="w-4 h-4" />
              Belum terhubung ke server
            </p>
          )}
        </div>

        {/* FEATURES */}
        <div className="grid grid-cols-3 gap-3 pt-6 border-t border-gray-200/20">
          <div className="text-center">
            <div className="text-2xl mb-1">📷</div>
            <p className={`text-xs ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>Live Video</p>
          </div>
          <div className="text-center">
            <div className="text-2xl mb-1">🔊</div>
            <p className={`text-xs ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>Audio Clear</p>
          </div>
          <div className="text-center">
            <div className="text-2xl mb-1">👶</div>
            <p className={`text-xs ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>Baby Status</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: VIDEO SECTION
// ============================================
function VideoSection({
  nightMode, videoRef, videoConnected, cameraOnline, babyStatus,
  connectionDuration, audioMuted, audioConnected, forcePlay, retryConnection,
  toggleAudioMute, volume, changeVolume, disconnect
}) {
  return (
    <div className="lg:col-span-2 space-y-4">
      {/* VIDEO CONTAINER */}
      <div className={`backdrop-blur-xl rounded-3xl border overflow-hidden transition-all ${
        nightMode
          ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
          : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
      } shadow-xl hover:shadow-2xl`}>
        <div className="relative bg-black rounded-3xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            onClick={forcePlay}
            className="w-full h-full object-cover cursor-pointer"
          />
          
          {/* NO VIDEO OVERLAY */}
          {!videoConnected && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-black/50 to-black/80 backdrop-blur-sm">
              {!cameraOnline ? (
                <>
                  <VideoOff className="w-20 h-20 text-red-400/60 mb-4 animate-pulse" />
                  <p className="text-gray-300 text-lg font-medium">Menunggu Kamera Terhubung...</p>
                  <p className="text-gray-500 text-sm mt-2">Pastikan camera app sudah aktif</p>
                </>
              ) : (
                <>
                  <Loader className="w-20 h-20 text-indigo-400 mb-4 animate-spin" />
                  <p className="text-gray-300 text-lg font-medium">Menghubungkan Video...</p>
                  <button
                    onClick={retryConnection}
                    className="mt-6 px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white rounded-xl font-semibold flex items-center gap-2 transition-all hover:scale-105 active:scale-95"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Coba Ulang
                  </button>
                </>
              )}
            </div>
          )}

          {/* CLICK TO UNMUTE HINT */}
          {videoConnected && audioMuted && audioConnected && (
            <div 
              className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm cursor-pointer hover:bg-black/40 transition-all"
              onClick={forcePlay}
            >
              <div className="text-center animate-in zoom-in">
                <VolumeX className="w-16 h-16 text-white mx-auto mb-3" />
                <p className="text-white text-lg font-semibold">Klik untuk aktifkan audio</p>
              </div>
            </div>
          )}

          {/* STATUS OVERLAYS */}
          <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none">
            {/* LEFT SECTION */}
            <div className="flex flex-col gap-3">
              {/* Camera Status */}
              <div className={`backdrop-blur-lg rounded-2xl px-4 py-2 flex items-center gap-2 border transition-all ${
                cameraOnline
                  ? 'bg-green-500/20 border-green-500/40 text-green-300'
                  : 'bg-red-500/20 border-red-500/40 text-red-300'
              }`}>
                {cameraOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                <span className="text-sm font-medium">{cameraOnline ? 'Kamera Online' : 'Offline'}</span>
              </div>
              
              {/* Live Badge */}
              {videoConnected && (
                <div className="flex gap-2">
                  <div className="backdrop-blur-lg rounded-2xl px-4 py-2 bg-green-500/30 border border-green-500/50 text-green-300 flex items-center gap-2 animate-pulse">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-sm font-bold">LIVE</span>
                  </div>
                  {audioConnected && (
                    <div className={`backdrop-blur-lg rounded-2xl px-4 py-2 border flex items-center gap-2 transition-all ${
                      audioMuted
                        ? 'bg-red-500/20 border-red-500/40 text-red-300'
                        : 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                    }`}>
                      {audioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                      <span className="text-sm font-medium">{audioMuted ? 'Muted' : 'Audio'}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* BABY STATUS - RIGHT SECTION */}
            <div className={`backdrop-blur-lg rounded-2xl px-5 py-3 border font-bold text-lg transition-all ${
              babyStatus === 'sleeping'
                ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                : babyStatus === 'awake'
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 animate-pulse'
                  : 'bg-gray-500/20 border-gray-500/40 text-gray-300'
            }`}>
              {babyStatus === 'sleeping' ? '😴' : babyStatus === 'awake' ? '👀' : '❓'} 
              <span className="ml-2 text-base font-semibold">
                {babyStatus === 'sleeping' ? 'Tidur' : babyStatus === 'awake' ? 'Bangun' : 'Monitoring'}
              </span>
            </div>
          </div>
          
          {/* CONNECTION DURATION */}
          {connectionDuration && (
            <div className="absolute bottom-4 left-4 backdrop-blur-lg rounded-2xl px-4 py-2 bg-black/40 border border-white/20 text-white text-sm font-mono">
              ⏱️ {connectionDuration}
            </div>
          )}
        </div>
      </div>

      {/* AUDIO CONTROLS */}
      {videoConnected && audioConnected && (
        <div className={`backdrop-blur-xl rounded-3xl border p-5 transition-all ${
          nightMode
            ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
            : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
        } shadow-lg`}>
          <div className="flex items-center gap-4">
            <button
              onClick={toggleAudioMute}
              className={`flex-shrink-0 p-3 rounded-2xl transition-all hover:scale-110 ${
                audioMuted
                  ? 'bg-gradient-to-br from-red-500 to-red-600 text-white shadow-lg'
                  : 'bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg'
              }`}
            >
              {audioMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
            </button>
            
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <p className={`text-sm font-semibold ${nightMode ? 'text-slate-300' : 'text-gray-700'}`}>
                  Volume
                </p>
                <span className={`text-sm font-bold ${nightMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
                  {volume}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(e) => changeVolume(parseInt(e.target.value))}
                disabled={audioMuted}
                className={`w-full h-3 rounded-full appearance-none cursor-pointer transition-all ${
                  nightMode
                    ? 'bg-slate-700'
                    : 'bg-gray-300'
                } [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gradient-to-r [&::-webkit-slider-thumb]:from-indigo-500 [&::-webkit-slider-thumb]:to-purple-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg`}
              />
            </div>
          </div>
        </div>
      )}

      {/* ACTION BUTTONS */}
      <div className="flex gap-3">
        <button
          onClick={disconnect}
          className="flex-1 py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white shadow-lg hover:shadow-xl hover:scale-105 active:scale-95"
        >
          <XCircle className="w-5 h-5" />
          Putuskan
        </button>
        
        <button
          onClick={retryConnection}
          className={`flex-1 py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 ${
            nightMode
              ? 'bg-slate-700/50 text-slate-200 hover:bg-slate-600/50'
              : 'bg-white/50 text-gray-700 hover:bg-white/70'
          } shadow-lg hover:shadow-xl hover:scale-105 active:scale-95`}
        >
          <RefreshCw className="w-5 h-5" />
          Refresh
        </button>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: SIDE PANEL
// ============================================
function SidePanel({ nightMode, babyStatus, audioConnected, sleepStats, alertHistory }) {
  return (
    <div className="space-y-4">
      {/* STATUS CARD */}
      <div className={`backdrop-blur-xl rounded-3xl border p-6 transition-all ${
        nightMode
          ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
          : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
      } shadow-xl hover:shadow-2xl`}>
        <h3 className={`font-bold mb-5 text-lg flex items-center gap-2 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
          <Heart className={`w-5 h-5 ${babyStatus === 'awake' ? 'text-red-500 animate-pulse' : 'text-slate-400'}`} />
          Status Bayi
        </h3>
        
        <div className={`p-6 rounded-2xl border-2 transition-all ${
          babyStatus === 'sleeping'
            ? nightMode
              ? 'bg-blue-500/10 border-blue-500/30'
              : 'bg-blue-50 border-blue-300'
            : babyStatus === 'awake'
              ? nightMode
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-amber-50 border-amber-300'
              : nightMode
                ? 'bg-slate-700/50 border-slate-600'
                : 'bg-gray-50 border-gray-300'
        }`}>
          <div className="flex items-center gap-3 mb-3">
            {babyStatus === 'sleeping' ? (
              <Moon className="w-7 h-7 text-blue-500" />
            ) : (
              <Sun className="w-7 h-7 text-amber-500" />
            )}
            <span className={`text-sm font-semibold ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>
              Status Terkini
            </span>
          </div>
          <p className={`text-3xl font-black ${
            babyStatus === 'sleeping'
              ? 'text-blue-600'
              : babyStatus === 'awake'
                ? 'text-amber-600'
                : nightMode
                  ? 'text-slate-400'
                  : 'text-gray-600'
          }`}>
            {babyStatus === 'sleeping' ? '😴 Tidur' : 
             babyStatus === 'awake' ? '👀 Bangun' : '⏳ Monitoring'}
          </p>
        </div>

        {/* STATS GRID */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <StatCard 
            icon={<Clock className="w-5 h-5" />}
            label="Terbangun"
            value={`${sleepStats.awakeCount}x`}
            nightMode={nightMode}
          />
          <StatCard 
            icon={<Volume2 className="w-5 h-5" />}
            label="Audio"
            value={audioConnected ? '🔊' : '🔇'}
            isActive={audioConnected}
            nightMode={nightMode}
          />
        </div>
      </div>

      {/* ALERTS CARD */}
      <div className={`backdrop-blur-xl rounded-3xl border p-6 transition-all ${
        nightMode
          ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
          : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
      } shadow-xl hover:shadow-2xl`}>
        <h3 className={`font-bold mb-4 text-lg flex items-center gap-2 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
          <Bell className="w-5 h-5 text-amber-500" />
          Riwayat Alert
        </h3>
        
        {alertHistory.length === 0 ? (
          <div className={`text-center py-8 ${nightMode ? 'text-slate-400' : 'text-gray-500'}`}>
            <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">Belum ada notifikasi</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {alertHistory.slice(0, 6).map((alert) => (
              <AlertItem 
                key={alert.id}
                alert={alert}
                nightMode={nightMode}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: STAT CARD
// ============================================
function StatCard({ icon, label, value, isActive, nightMode }) {
  return (
    <div className={`p-4 rounded-2xl transition-all ${
      isActive
        ? nightMode
          ? 'bg-green-500/20 border border-green-500/40'
          : 'bg-green-50 border border-green-200'
        : nightMode
          ? 'bg-slate-700/50 border border-slate-600'
          : 'bg-white/50 border border-gray-200'
    }`}>
      <div className={`${isActive ? (nightMode ? 'text-green-400' : 'text-green-600') : (nightMode ? 'text-slate-400' : 'text-gray-600')} mb-2`}>
        {icon}
      </div>
      <p className={`text-xs font-medium mb-1 ${nightMode ? 'text-slate-400' : 'text-gray-600'}`}>
        {label}
      </p>
      <p className={`text-2xl font-bold ${
        isActive ? (nightMode ? 'text-green-400' : 'text-green-600') : (nightMode ? 'text-slate-300' : 'text-gray-700')
      }`}>
        {value}
      </p>
    </div>
  );
}

// ============================================
// COMPONENT: ALERT ITEM
// ============================================
function AlertItem({ alert, nightMode }) {
  const alertStyles = {
    alert: nightMode
      ? 'bg-red-500/10 border-red-500/30'
      : 'bg-red-50 border-red-200',
    warning: nightMode
      ? 'bg-amber-500/10 border-amber-500/30'
      : 'bg-amber-50 border-amber-200',
    info: nightMode
      ? 'bg-blue-500/10 border-blue-500/30'
      : 'bg-blue-50 border-blue-200'
  };

  const textColors = {
    alert: nightMode ? 'text-red-300' : 'text-red-800',
    warning: nightMode ? 'text-amber-300' : 'text-amber-800',
    info: nightMode ? 'text-blue-300' : 'text-blue-800'
  };

  return (
    <div className={`p-3 rounded-xl border backdrop-blur-sm transition-all ${alertStyles[alert.type]}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`text-sm font-semibold ${textColors[alert.type]}`}>
          {alert.message}
        </span>
        <span className={`text-xs whitespace-nowrap ${nightMode ? 'text-slate-500' : 'text-gray-500'}`}>
          {alert.time}
        </span>
      </div>
    </div>
  );
}

// ============================================
// COMPONENT: DEBUG PANEL
// ============================================
function DebugPanel({ nightMode, debugLogs, setDebugLogs }) {
  return (
    <div className={`mt-6 backdrop-blur-xl rounded-3xl border p-6 transition-all ${
      nightMode
        ? 'bg-gradient-to-br from-slate-800/40 to-slate-700/40 border-slate-600/30'
        : 'bg-gradient-to-br from-white/60 to-blue-50/60 border-white/60'
    } shadow-xl animate-in slide-in-from-bottom duration-300`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className={`font-bold text-lg flex items-center gap-2 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
          <Activity className="w-5 h-5 text-indigo-500" />
          Debug Logs
        </h3>
        <button 
          onClick={() => setDebugLogs([])}
          className={`text-xs font-semibold px-3 py-1 rounded-lg transition-all ${
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
            className={`py-0.5 transition-all ${
              log.type === 'error' ? 'text-red-400' :
              log.type === 'warning' ? 'text-amber-400' :
              log.type === 'success' ? 'text-green-400' :
              nightMode ? 'text-gray-400' : 'text-gray-300'
            }`}
          >
            <span className={`opacity-50 ${nightMode ? 'text-slate-600' : 'text-gray-600'}`}>
              [{log.time}]
            </span> {log.message}
          </div>
        ))}
        {debugLogs.length === 0 && (
          <p className={`text-center py-4 ${nightMode ? 'text-slate-600' : 'text-gray-500'}`}>
            No logs yet...
          </p>
        )}
      </div>
    </div>
  );
}
