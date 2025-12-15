import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { 
  Monitor, Video, VideoOff, Wifi, WifiOff, Bell, BellOff,
  Moon, Sun, Activity, Maximize, Minimize, Camera, Clock, 
  TrendingUp, RefreshCw, Volume2, VolumeX, AlertTriangle,
  CheckCircle, XCircle, Loader
} from 'lucide-react';

// Ganti dengan URL Hugging Face Space Anda
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
  
  // Baby Status
  const [babyStatus, setBabyStatus] = useState('unknown');
  const [lastStatusUpdate, setLastStatusUpdate] = useState(null);
  
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

  // Initialize socket connection
  useEffect(() => {
    addDebugLog('Initializing socket connection...');
    
    const newSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socketRef.current = newSocket;

    newSocket.on('connect', () => {
      addDebugLog('✅ Socket connected to server', 'success');
      setSocketConnected(true);
      setError('');
    });

    newSocket.on('disconnect', (reason) => {
      addDebugLog(`❌ Socket disconnected: ${reason}`, 'error');
      setSocketConnected(false);
      setVideoConnected(false);
    });

    newSocket.on('connect_error', (err) => {
      addDebugLog(`❌ Connection error: ${err.message}`, 'error');
      setError('Gagal terhubung ke server. Periksa koneksi internet.');
      setSocketConnected(false);
    });

    newSocket.on('reconnect', (attemptNumber) => {
      addDebugLog(`🔄 Reconnected after ${attemptNumber} attempts`, 'success');
      setSocketConnected(true);
    });

    newSocket.on('monitor-joined', ({ roomCode: code, cameraOnline: camOnline, babyStatus: status }) => {
      addDebugLog(`✅ Joined room: ${code}, Camera: ${camOnline ? 'online' : 'offline'}`, 'success');
      setIsConnected(true);
      setIsConnecting(false);
      setRoomCode(code);
      setCameraOnline(camOnline);
      setBabyStatus(status || 'unknown');
      setSleepStats(prev => ({ ...prev, connectionTime: new Date() }));
      addAlert('info', `Terhubung ke ruangan ${code}`);
    });

    newSocket.on('camera-online', () => {
      addDebugLog('📷 Camera came online', 'success');
      setCameraOnline(true);
      addAlert('info', '📷 Kamera terhubung');
    });

    newSocket.on('camera-offline', () => {
      addDebugLog('📷 Camera went offline', 'warning');
      setCameraOnline(false);
      setVideoConnected(false);
      addAlert('warning', '📷 Kamera terputus');
      
      // Clear video
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      
      // Close peer connection
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    });

    // WebRTC signaling
    newSocket.on('offer', async ({ offer, senderId }) => {
      addDebugLog(`📥 Received offer from camera: ${senderId}`);
      await handleOffer(offer, senderId, newSocket);
    });

    newSocket.on('ice-candidate', async ({ candidate, senderId }) => {
      if (peerConnectionRef.current && candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          addDebugLog('🧊 Added ICE candidate');
        } catch (e) {
          addDebugLog(`❌ Error adding ICE candidate: ${e.message}`, 'error');
        }
      }
    });

    // Baby status updates
    newSocket.on('baby-status-changed', ({ status, confidence, notes, previousStatus, timestamp, imageSnapshot }) => {
      addDebugLog(`👶 Baby status: ${previousStatus} → ${status} (${confidence}%)`);
      
      const prevStatus = babyStatus;
      setBabyStatus(status);
      setLastStatusUpdate(new Date(timestamp));
      
      if (imageSnapshot) {
        setLastSnapshot(imageSnapshot);
      }

      // Alert if baby woke up
      if ((prevStatus === 'sleeping' || previousStatus === 'sleeping') && status === 'awake') {
        const alertMsg = `👶 Bayi terbangun! ${confidence > 0 ? `(${confidence}% yakin)` : ''}`;
        addAlert('alert', alertMsg);
        
        if (notifications) {
          if (soundEnabled) {
            playAlertSound();
          }
          showBrowserNotification('Bayi Terbangun!', notes || 'Bayi terdeteksi bangun');
        }

        setSleepStats(prev => ({
          ...prev,
          awakeCount: prev.awakeCount + 1,
          lastAwake: new Date()
        }));
      } else if (status === 'sleeping' && prevStatus === 'awake') {
        addAlert('info', '😴 Bayi kembali tidur');
      }
    });

    newSocket.on('error', ({ message }) => {
      addDebugLog(`❌ Server error: ${message}`, 'error');
      setError(message);
      setIsConnecting(false);
    });

    setSocket(newSocket);

    return () => {
      addDebugLog('Cleaning up socket connection...');
      newSocket.disconnect();
    };
  }, []);

  // Handle WebRTC offer
  const handleOffer = async (offer, senderId, socket) => {
    addDebugLog('🔧 Creating peer connection...');
    
    // Close existing connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Free TURN servers for better connectivity
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

    try {
      const pc = new RTCPeerConnection(configuration);
      peerConnectionRef.current = pc;

      // Receive remote track - THIS IS KEY FOR VIDEO
      pc.ontrack = (event) => {
        addDebugLog(`🎥 Received track: ${event.track.kind}`, 'success');
        
        if (event.streams && event.streams[0]) {
          addDebugLog('📺 Setting video stream...', 'success');
          
          if (videoRef.current) {
            videoRef.current.srcObject = event.streams[0];
            
            // Try to play
            videoRef.current.play()
              .then(() => {
                addDebugLog('▶️ Video playing!', 'success');
                setVideoConnected(true);
                addAlert('info', '🎥 Video terhubung!');
              })
              .catch(err => {
                addDebugLog(`⚠️ Autoplay blocked: ${err.message}`, 'warning');
                // Video will play when user interacts
              });
          }
        }
      };

      // ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          addDebugLog('🧊 Sending ICE candidate to camera');
          socket.emit('ice-candidate', {
            candidate: event.candidate,
            targetId: senderId
          });
        }
      };

      // ICE gathering state
      pc.onicegatheringstatechange = () => {
        addDebugLog(`🧊 ICE gathering state: ${pc.iceGatheringState}`);
      };

      // Connection state changes
      pc.onconnectionstatechange = () => {
        addDebugLog(`🔌 Connection state: ${pc.connectionState}`);
        
        switch (pc.connectionState) {
          case 'connected':
            addDebugLog('✅ WebRTC Connected!', 'success');
            setVideoConnected(true);
            break;
          case 'disconnected':
            addDebugLog('⚠️ WebRTC Disconnected', 'warning');
            setVideoConnected(false);
            break;
          case 'failed':
            addDebugLog('❌ WebRTC Connection Failed', 'error');
            setVideoConnected(false);
            addAlert('warning', 'Koneksi video gagal. Coba refresh.');
            break;
          case 'closed':
            addDebugLog('🔒 WebRTC Connection Closed');
            setVideoConnected(false);
            break;
        }
      };

      // ICE connection state
      pc.oniceconnectionstatechange = () => {
        addDebugLog(`🧊 ICE connection state: ${pc.iceConnectionState}`);
        
        if (pc.iceConnectionState === 'failed') {
          addDebugLog('🔄 ICE failed, attempting restart...', 'warning');
          pc.restartIce();
        }
      };

      // Set remote description (the offer)
      addDebugLog('📝 Setting remote description...');
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Create answer
      addDebugLog('📝 Creating answer...');
      const answer = await pc.createAnswer();
      
      // Set local description
      addDebugLog('📝 Setting local description...');
      await pc.setLocalDescription(answer);

      // Send answer back to camera
      addDebugLog(`📤 Sending answer to camera: ${senderId}`);
      socket.emit('answer', {
        answer: pc.localDescription,
        targetId: senderId
      });

      addDebugLog('✅ WebRTC handshake complete, waiting for video...', 'success');

    } catch (err) {
      addDebugLog(`❌ Error in handleOffer: ${err.message}`, 'error');
      setError('Gagal membuat koneksi video: ' + err.message);
    }
  };

  // Join room
  const joinRoom = async () => {
    const code = inputCode.trim().toUpperCase();
    
    if (!code || code.length !== 6) {
      setError('Masukkan kode ruangan 6 karakter');
      return;
    }

    if (!socketConnected) {
      setError('Belum terhubung ke server. Tunggu sebentar...');
      return;
    }

    setIsConnecting(true);
    setError('');
    addDebugLog(`Joining room: ${code}`);

    try {
      // Check if room exists
      const response = await fetch(`${SERVER_URL}/api/room/${code}`);
      const data = await response.json();

      if (!data.exists) {
        setError('Kode ruangan tidak ditemukan');
        setIsConnecting(false);
        return;
      }

      addDebugLog(`Room ${code} exists, camera: ${data.hasCamera ? 'online' : 'offline'}`);
      
      // Join via socket
      socket.emit('monitor-join', { roomCode: code });
      
    } catch (err) {
      addDebugLog(`❌ Error joining room: ${err.message}`, 'error');
      setError('Gagal terhubung: ' + err.message);
      setIsConnecting(false);
    }
  };

  // Add alert to history
  const addAlert = useCallback((type, message) => {
    const alert = {
      id: Date.now(),
      type,
      message,
      time: new Date().toLocaleTimeString('id-ID')
    };
    setAlertHistory(prev => [alert, ...prev.slice(0, 19)]);
  }, []);

  // Play alert sound
  const playAlertSound = useCallback(() => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // Create a more noticeable sound
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
      
      addDebugLog('🔊 Alert sound played');
    } catch (e) {
      addDebugLog(`⚠️ Could not play sound: ${e.message}`, 'warning');
    }
  }, [addDebugLog]);

  // Show browser notification
  const showBrowserNotification = useCallback((title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { 
          body, 
          icon: '👶',
          badge: '👶',
          vibrate: [200, 100, 200],
          requireInteraction: true
        });
        addDebugLog('📢 Browser notification shown');
      } catch (e) {
        addDebugLog(`⚠️ Notification error: ${e.message}`, 'warning');
      }
    }
  }, [addDebugLog]);

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
          addDebugLog(`Notification permission: ${permission}`);
        });
      } else {
        addDebugLog(`Notification permission: ${Notification.permission}`);
      }
    }
  }, [addDebugLog]);

  // Toggle fullscreen
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().then(() => {
        setFullscreen(true);
      }).catch(err => {
        addDebugLog(`Fullscreen error: ${err.message}`, 'warning');
      });
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

  // Listen for fullscreen change
  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Disconnect
  const disconnect = () => {
    addDebugLog('Disconnecting...');
    
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
    setRoomCode('');
    setInputCode('');
    setBabyStatus('unknown');
    setLastSnapshot(null);
  };

  // Retry connection
  const retryConnection = () => {
    addDebugLog('Retrying connection...');
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    
    setVideoConnected(false);
    
    // Re-request connection from camera
    if (socket && roomCode) {
      socket.emit('monitor-join', { roomCode });
    }
  };

  // Format time ago
  const timeAgo = (date) => {
    if (!date) return '-';
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds} detik lalu`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} menit lalu`;
    const hours = Math.floor(minutes / 60);
    return `${hours} jam lalu`;
  };

  // Connection time display
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
      className={`min-h-screen ${nightMode ? 'bg-gray-900' : 'bg-gradient-to-br from-slate-100 to-blue-100'} p-4 transition-colors duration-300`}
    >
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4 mb-4 transition-colors duration-300`}>
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
                  {isConnected && (
                    <span className={`${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      • Ruangan: <strong>{roomCode}</strong>
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {/* Notification Toggle */}
              <button
                onClick={() => setNotifications(!notifications)}
                className={`p-2 rounded-lg transition-colors ${
                  notifications 
                    ? 'bg-green-100 text-green-600 hover:bg-green-200' 
                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                }`}
                title={notifications ? 'Notifikasi aktif' : 'Notifikasi mati'}
              >
                {notifications ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              </button>
              
              {/* Sound Toggle */}
              <button
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={`p-2 rounded-lg transition-colors ${
                  soundEnabled 
                    ? 'bg-blue-100 text-blue-600 hover:bg-blue-200' 
                    : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                }`}
                title={soundEnabled ? 'Suara aktif' : 'Suara mati'}
              >
                {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
              </button>
              
              {/* Night Mode */}
              <button
                onClick={() => setNightMode(!nightMode)}
                className={`p-2 rounded-lg transition-colors ${
                  nightMode 
                    ? 'bg-yellow-500 text-white hover:bg-yellow-600' 
                    : 'bg-gray-800 text-white hover:bg-gray-700'
                }`}
                title={nightMode ? 'Mode siang' : 'Mode malam'}
              >
                {nightMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              
              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className={`p-2 rounded-lg ${nightMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'} hover:opacity-80`}
                title={fullscreen ? 'Keluar fullscreen' : 'Fullscreen'}
              >
                {fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
              
              {/* Debug Toggle */}
              <button
                onClick={() => setShowDebug(!showDebug)}
                className={`p-2 rounded-lg ${
                  showDebug 
                    ? 'bg-purple-100 text-purple-600' 
                    : nightMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'
                } hover:opacity-80`}
                title="Toggle debug logs"
              >
                <Activity className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-xl mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <span>{error}</span>
            <button 
              onClick={() => setError('')}
              className="ml-auto text-red-700 hover:text-red-900"
            >
              ✕
            </button>
          </div>
        )}

        {/* Join Room - Show when not connected */}
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
                Dapatkan kode 6 digit dari Camera App di HP yang ada di kamar bayi
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
                  className={`flex-1 text-center text-2xl font-mono tracking-[0.3em] py-3 rounded-xl border-2 transition-colors ${
                    nightMode 
                      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-indigo-500' 
                      : 'bg-gray-50 border-gray-200 focus:border-indigo-500'
                  } focus:outline-none`}
                />
                <button
                  onClick={joinRoom}
                  disabled={isConnecting || !socketConnected}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white px-6 py-3 rounded-xl font-semibold transition-colors flex items-center gap-2"
                >
                  {isConnecting ? (
                    <>
                      <Loader className="w-5 h-5 animate-spin" />
                      <span className="hidden sm:inline">Menghubungkan...</span>
                    </>
                  ) : (
                    <>
                      <Wifi className="w-5 h-5" />
                      <span className="hidden sm:inline">Hubungkan</span>
                    </>
                  )}
                </button>
              </div>
              
              {/* Server Status */}
              <div className={`mt-6 p-3 rounded-lg ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <div className="flex items-center justify-center gap-2">
                  {socketConnected ? (
                    <>
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      <span className={`text-sm ${nightMode ? 'text-gray-300' : 'text-gray-600'}`}>
                        Server terhubung
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 bg-red-500 rounded-full" />
                      <span className={`text-sm ${nightMode ? 'text-gray-300' : 'text-gray-600'}`}>
                        Menghubungkan ke server...
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Main Content - Show when connected */}
        {isConnected && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Video Feed */}
            <div className="lg:col-span-2">
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <div 
                  className="relative bg-black rounded-xl overflow-hidden" 
                  style={{ aspectRatio: '16/9' }}
                >
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted={false}
                    className="w-full h-full object-cover"
                    onClick={() => {
                      // Try to play on click (for autoplay blocked)
                      if (videoRef.current) {
                        videoRef.current.play().catch(() => {});
                      }
                    }}
                  />
                  
                  {/* Overlay when no video */}
                  {!videoConnected && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/90">
                      {!cameraOnline ? (
                        <>
                          <VideoOff className="w-16 h-16 text-gray-500 mb-4" />
                          <p className="text-gray-400 text-lg">Menunggu kamera...</p>
                          <p className="text-gray-500 text-sm mt-2">
                            Pastikan Camera App sudah streaming
                          </p>
                        </>
                      ) : (
                        <>
                          <Loader className="w-16 h-16 text-indigo-500 mb-4 animate-spin" />
                          <p className="text-gray-400 text-lg">Menghubungkan video...</p>
                          <p className="text-gray-500 text-sm mt-2">
                            Kamera online, menunggu koneksi WebRTC
                          </p>
                          <button
                            onClick={retryConnection}
                            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-2"
                          >
                            <RefreshCw className="w-4 h-4" />
                            Coba Ulang
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Status Overlay */}
                  <div className="absolute top-4 left-4 right-4 flex justify-between items-start">
                    {/* Connection Status */}
                    <div className="flex flex-col gap-2">
                      <div className={`px-3 py-1.5 rounded-full flex items-center gap-2 ${
                        cameraOnline ? 'bg-green-500' : 'bg-red-500'
                      } text-white text-sm font-medium`}>
                        {cameraOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                        {cameraOnline ? 'Kamera Online' : 'Kamera Offline'}
                      </div>
                      
                      {videoConnected && (
                        <div className="px-3 py-1.5 rounded-full bg-green-500/80 text-white text-sm flex items-center gap-2">
                          <Video className="w-4 h-4" />
                          LIVE
                        </div>
                      )}
                    </div>
                    
                    {/* Baby Status */}
                    <div className={`px-4 py-2 rounded-full ${
                      babyStatus === 'sleeping' ? 'bg-blue-500' : 
                      babyStatus === 'awake' ? 'bg-amber-500' : 'bg-gray-500'
                    } text-white text-lg font-medium`}>
                      {babyStatus === 'sleeping' ? '😴 Tidur' : 
                       babyStatus === 'awake' ? '👀 Bangun' : '❓ Memantau...'}
                    </div>
                  </div>
                  
                  {/* Connection Duration */}
                  {connectionDuration && (
                    <div className="absolute bottom-4 left-4 px-3 py-1 rounded-full bg-black/50 text-white text-sm">
                      ⏱️ {connectionDuration}
                    </div>
                  )}
                </div>

                {/* Controls */}
                <div className="mt-4 flex gap-3 flex-wrap">
                  <button
                    onClick={disconnect}
                    className="flex-1 min-w-[140px] bg-red-600 hover:bg-red-700 text-white py-3 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <XCircle className="w-5 h-5" />
                    Putuskan
                  </button>
                  
                  <button
                    onClick={retryConnection}
                    className={`flex-1 min-w-[140px] ${nightMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'} ${nightMode ? 'text-white' : 'text-gray-800'} py-3 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2`}
                  >
                    <RefreshCw className="w-5 h-5" />
                    Refresh
                  </button>
                </div>
              </div>
            </div>

            {/* Side Panel */}
            <div className="space-y-4">
              {/* Status Card */}
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <h3 className={`font-semibold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  📊 Status Bayi
                </h3>
                
                <div className={`p-4 rounded-xl border-2 ${
                  babyStatus === 'sleeping' ? 'bg-blue-50 border-blue-300' : 
                  babyStatus === 'awake' ? 'bg-amber-50 border-amber-300' : 
                  'bg-gray-50 border-gray-300'
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {babyStatus === 'sleeping' ? (
                      <Moon className="w-6 h-6 text-blue-600" />
                    ) : babyStatus === 'awake' ? (
                      <Sun className="w-6 h-6 text-amber-600" />
                    ) : (
                      <Activity className="w-6 h-6 text-gray-600" />
                    )}
                    <span className="text-sm font-medium text-gray-600">Status Saat Ini</span>
                  </div>
                  <p className="text-2xl font-bold text-gray-800">
                    {babyStatus === 'sleeping' ? '😴 Tidur Nyenyak' : 
                     babyStatus === 'awake' ? '👀 Terjaga' : '⏳ Memantau...'}
                  </p>
                  {lastStatusUpdate && (
                    <p className="text-xs text-gray-500 mt-1">
                      Update: {timeAgo(lastStatusUpdate)}
                    </p>
                  )}
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <div className={`p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                    <Clock className={`w-5 h-5 ${nightMode ? 'text-gray-400' : 'text-gray-600'} mb-1`} />
                    <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>Terbangun</p>
                    <p className={`text-xl font-bold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                      {sleepStats.awakeCount}x
                    </p>
                  </div>
                  <div className={`p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                    <TrendingUp className={`w-5 h-5 ${nightMode ? 'text-gray-400' : 'text-gray-600'} mb-1`} />
                    <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>Video</p>
                    <p className={`text-xl font-bold ${videoConnected ? 'text-green-500' : 'text-red-500'}`}>
                      {videoConnected ? '🟢' : '🔴'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Alert History */}
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <h3 className={`font-semibold mb-4 flex items-center gap-2 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  <Bell className="w-5 h-5 text-amber-500" />
                  Riwayat Alert
                  {alertHistory.length > 0 && (
                    <span className="ml-auto text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                      {alertHistory.length}
                    </span>
                  )}
                </h3>
                
                {alertHistory.length === 0 ? (
                  <p className={`text-sm ${nightMode ? 'text-gray-400' : 'text-gray-500'} text-center py-6`}>
                    Belum ada notifikasi
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {alertHistory.map((alert) => (
                      <div 
                        key={alert.id}
                        className={`p-3 rounded-lg border ${
                          alert.type === 'alert' ? 'bg-red-50 border-red-200' :
                          alert.type === 'warning' ? 'bg-amber-50 border-amber-200' :
                          'bg-blue-50 border-blue-200'
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <span className={`text-sm font-medium ${
                            alert.type === 'alert' ? 'text-red-800' :
                            alert.type === 'warning' ? 'text-amber-800' :
                            'text-blue-800'
                          }`}>
                            {alert.message}
                          </span>
                          <span className="text-xs text-gray-500 flex-shrink-0">
                            {alert.time}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Last Snapshot */}
              {lastSnapshot && (
                <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                  <h3 className={`font-semibold mb-3 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                    📸 Snapshot Terakhir
                  </h3>
                  <img 
                    src={lastSnapshot} 
                    alt="Last snapshot"
                    className="w-full rounded-xl"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Debug Logs Panel */}
        {showDebug && (
          <div className={`mt-4 ${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-semibold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                🔧 Debug Logs
              </h3>
              <button
                onClick={() => setDebugLogs([])}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Clear
              </button>
            </div>
            <div className={`${nightMode ? 'bg-gray-900' : 'bg-gray-100'} rounded-lg p-3 max-h-60 overflow-y-auto font-mono text-xs`}>
              {debugLogs.length === 0 ? (
                <p className="text-gray-500">No logs yet...</p>
              ) : (
                debugLogs.map((log, idx) => (
                  <div key={idx} className={`py-0.5 ${
                    log.type === 'error' ? 'text-red-500' :
                    log.type === 'warning' ? 'text-amber-500' :
                    log.type === 'success' ? 'text-green-500' :
                    nightMode ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    <span className="text-gray-500">[{log.time}]</span> {log.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Footer Tips */}
        <div className={`mt-4 ${nightMode ? 'bg-indigo-900/50' : 'bg-indigo-50'} rounded-xl p-4`}>
          <p className={`text-sm ${nightMode ? 'text-indigo-200' : 'text-indigo-800'}`}>
            💡 <strong>Tips:</strong> Jika video tidak muncul, pastikan Camera App sudah klik "Mulai Streaming" terlebih dahulu. 
            Klik tombol Refresh jika koneksi terputus.
          </p>
        </div>
      </div>
    </div>
  );
}
