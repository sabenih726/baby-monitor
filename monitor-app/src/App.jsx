import React, { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';
import { 
  Monitor, Video, VideoOff, Wifi, WifiOff, Bell, BellOff,
  Moon, Sun, Activity, Volume2, VolumeX, Maximize, Camera,
  AlertTriangle, Clock, TrendingUp
} from 'lucide-react';

const SERVER_URL = 'http://YOUR_SERVER_IP:3001'; // Ganti dengan IP server

export default function MonitorApp() {
  const [socket, setSocket] = useState(null);
  const [roomCode, setRoomCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [cameraOnline, setCameraOnline] = useState(false);
  const [babyStatus, setBabyStatus] = useState('unknown');
  const [notifications, setNotifications] = useState(true);
  const [alertHistory, setAlertHistory] = useState([]);
  const [lastSnapshot, setLastSnapshot] = useState(null);
  const [nightMode, setNightMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [sleepStats, setSleepStats] = useState({
    totalSleep: 0,
    awakeCount: 0,
    lastAwake: null
  });
  
  const videoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const containerRef = useRef(null);

  // Initialize socket
  useEffect(() => {
    const newSocket = io(SERVER_URL);
    
    newSocket.on('connect', () => {
      console.log('Connected to server');
    });

    newSocket.on('monitor-joined', ({ roomCode, cameraOnline, babyStatus }) => {
      setIsConnected(true);
      setRoomCode(roomCode);
      setCameraOnline(cameraOnline);
      setBabyStatus(babyStatus);
    });

    newSocket.on('camera-online', () => {
      setCameraOnline(true);
      addAlert('info', 'Kamera terhubung');
    });

    newSocket.on('camera-offline', () => {
      setCameraOnline(false);
      addAlert('warning', 'Kamera terputus');
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    });

    // WebRTC signaling
    newSocket.on('offer', async ({ offer, senderId }) => {
      await handleOffer(offer, senderId, newSocket);
    });

    newSocket.on('ice-candidate', async ({ candidate, senderId }) => {
      if (peerConnectionRef.current && candidate) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    // Baby status updates
    newSocket.on('baby-status-changed', ({ status, confidence, notes, previousStatus, timestamp, imageSnapshot }) => {
      const prevStatus = babyStatus;
      setBabyStatus(status);
      
      if (imageSnapshot) {
        setLastSnapshot(imageSnapshot);
      }

      // Alert if baby woke up
      if (prevStatus === 'sleeping' && status === 'awake') {
        addAlert('alert', `👶 Bayi terbangun! (${confidence}% yakin)`);
        
        if (notifications) {
          playAlertSound();
          showNotification('Bayi Terbangun!', notes || 'Bayi terdeteksi bangun');
        }

        setSleepStats(prev => ({
          ...prev,
          awakeCount: prev.awakeCount + 1,
          lastAwake: new Date()
        }));
      }
    });

    newSocket.on('error', ({ message }) => {
      alert(message);
    });

    setSocket(newSocket);

    return () => newSocket.disconnect();
  }, [babyStatus, notifications]);

  // Handle WebRTC offer
  const handleOffer = async (offer, senderId, socket) => {
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(configuration);
    peerConnectionRef.current = pc;

    pc.ontrack = (event) => {
      console.log('Received remote track');
      if (videoRef.current) {
        videoRef.current.srcObject = event.streams[0];
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

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer', {
      answer: answer,
      targetId: senderId
    });
  };

  // Join room
  const joinRoom = async () => {
    if (!inputCode || inputCode.length !== 6) {
      alert('Masukkan kode ruangan 6 karakter');
      return;
    }

    try {
      const response = await fetch(`${SERVER_URL}/api/room/${inputCode}`);
      const data = await response.json();

      if (!data.exists) {
        alert('Kode ruangan tidak ditemukan');
        return;
      }

      socket.emit('monitor-join', { roomCode: inputCode });
    } catch (err) {
      alert('Gagal terhubung ke server');
    }
  };

  // Add alert to history
  const addAlert = (type, message) => {
    const alert = {
      id: Date.now(),
      type,
      message,
      time: new Date().toLocaleTimeString('id-ID')
    };
    setAlertHistory(prev => [alert, ...prev.slice(0, 9)]);
  };

  // Play alert sound
  const playAlertSound = () => {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleC8LPH3N4dOveiwON2uu1ODMtEUiAB+R0u3exEQqExxnn8jQtk4cAQeL0OnVt0wpDxddmcLCp0QOAACEy+TRrEUmExRVkru9oT8KAAB/xuHPp0IjEA9Pir23mzoHAAB5wN3Mo0AhDgpJgrewnTUEAABzutrLnz4fDAZCe6+sl');
    audio.play().catch(() => {});
  };

  // Show browser notification
  const showNotification = (title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '👶' });
    }
  };

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
    setIsConnected(false);
    setCameraOnline(false);
    setRoomCode('');
    setInputCode('');
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  return (
    <div 
      ref={containerRef}
      className={`min-h-screen ${nightMode ? 'bg-gray-900' : 'bg-gradient-to-br from-slate-100 to-blue-100'} p-4`}
    >
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4 mb-4`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`${nightMode ? 'bg-indigo-900' : 'bg-indigo-100'} p-3 rounded-full`}>
                <Monitor className={`w-6 h-6 ${nightMode ? 'text-indigo-300' : 'text-indigo-600'}`} />
              </div>
              <div>
                <h1 className={`text-2xl font-bold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  🖥️ Baby Monitor
                </h1>
                <p className={`text-sm ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {isConnected ? `Ruangan: ${roomCode}` : 'Tidak terhubung'}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setNotifications(!notifications)}
                className={`p-2 rounded-lg ${notifications ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}
              >
                {notifications ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              </button>
              <button
                onClick={() => setNightMode(!nightMode)}
                className={`p-2 rounded-lg ${nightMode ? 'bg-yellow-500 text-white' : 'bg-gray-800 text-white'}`}
              >
                {nightMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-lg bg-gray-100 text-gray-600"
              >
                <Maximize className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Join Room - Show when not connected */}
        {!isConnected && (
          <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-8 mb-4`}>
            <div className="max-w-md mx-auto text-center">
              <Camera className={`w-16 h-16 mx-auto mb-4 ${nightMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
              <h2 className={`text-xl font-bold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                Masukkan Kode Ruangan
              </h2>
              <p className={`text-sm mb-6 ${nightMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Dapatkan kode dari Camera App di HP yang ada di kamar bayi
              </p>
              
              <div className="flex gap-3">
                <input
                  type="text"
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                  placeholder="ABC123"
                  maxLength={6}
                  className={`flex-1 text-center text-2xl font-mono tracking-widest py-3 rounded-xl border-2 ${
                    nightMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-50 border-gray-200'
                  }`}
                />
                <button
                  onClick={joinRoom}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-semibold"
                >
                  Hubungkan
                </button>
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
                <div className="relative bg-black rounded-xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />
                  
                  {!cameraOnline && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900">
                      <VideoOff className="w-16 h-16 text-gray-500 mb-4" />
                      <p className="text-gray-400">Menunggu kamera...</p>
                    </div>
                  )}

                  {/* Status Overlay */}
                  <div className="absolute top-4 left-4 right-4 flex justify-between">
                    <div className={`px-4 py-2 rounded-full flex items-center gap-2 ${
                      cameraOnline ? 'bg-green-500' : 'bg-red-500'
                    } text-white`}>
                      {cameraOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                      {cameraOnline ? 'Live' : 'Offline'}
                    </div>
                    
                    <div className={`px-4 py-2 rounded-full ${
                      babyStatus === 'sleeping' ? 'bg-blue-500' : 
                      babyStatus === 'awake' ? 'bg-amber-500' : 'bg-gray-500'
                    } text-white text-lg`}>
                      {babyStatus === 'sleeping' ? '😴 Tidur' : 
                       babyStatus === 'awake' ? '👀 Bangun' : '❓ Unknown'}
                    </div>
                  </div>
                </div>

                {/* Controls */}
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={disconnect}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white py-3 rounded-xl font-semibold"
                  >
                    Putuskan Koneksi
                  </button>
                </div>
              </div>
            </div>

            {/* Side Panel */}
            <div className="space-y-4">
              {/* Status Cards */}
              <div className={`${nightMode ? 'bg-gray-800' : 'bg-white'} rounded-2xl shadow-xl p-4`}>
                <h3 className={`font-semibold mb-4 ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                  📊 Status
                </h3>
                <div className="space-y-3">
                  <div className={`p-4 rounded-xl ${
                    babyStatus === 'sleeping' ? 'bg-blue-100 border-blue-300' : 
                    babyStatus === 'awake' ? 'bg-amber-100 border-amber-300' : 
                    'bg-gray-100 border-gray-300'
                  } border-2`}>
                    <div className="flex items-center gap-2 mb-1">
                      {babyStatus === 'sleeping' ? <Moon className="w-5 h-5 text-blue-600" /> : 
                       <Sun className="w-5 h-5 text-amber-600" />}
                      <span className="text-sm font-medium text-gray-600">Status Bayi</span>
                    </div>
                    <p className="text-2xl font-bold">
                      {babyStatus === 'sleeping' ? '😴 Tidur Nyenyak' : 
                       babyStatus === 'awake' ? '👀 Bangun' : '⏳ Memantau...'}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className={`p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                      <Clock className={`w-5 h-5 ${nightMode ? 'text-gray-400' : 'text-gray-600'} mb-1`} />
                      <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>Terbangun</p>
                      <p className={`text-lg font-bold ${nightMode ? 'text-white' : 'text-gray-800'}`}>
                        {sleepStats.awakeCount}x
                      </p>
                    </div>
                    <div className={`p-3 rounded-xl ${nightMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                      <TrendingUp className={`w-5 h-5 ${nightMode ? 'text-gray-400' : 'text-gray-600'} mb-1`} />
                      <p className={`text-xs ${nightMode ? 'text-gray-400' : 'text-gray-500'}`}>Koneksi</p>
                      <p className={`text-lg font-bold ${cameraOnline ? 'text-green-500' : 'text-red-500'}`}>
                        {cameraOnline ? 'Aktif' : 'Mati'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Alert History */}
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
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {alertHistory.map((alert) => (
                      <div 
                        key={alert.id}
                        className={`p-3 rounded-lg ${
                          alert.type === 'alert' ? 'bg-red-50 border-red-200' :
                          alert.type === 'warning' ? 'bg-amber-50 border-amber-200' :
                          'bg-blue-50 border-blue-200'
                        } border`}
                      >
                        <div className="flex justify-between items-start">
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

        {/* Footer Tips */}
        <div className={`mt-4 ${nightMode ? 'bg-indigo-900/50' : 'bg-indigo-50'} rounded-xl p-4`}>
          <p className={`text-sm ${nightMode ? 'text-indigo-200' : 'text-indigo-800'}`}>
            💡 <strong>Tips:</strong> Aktifkan notifikasi browser untuk mendapat alert ketika bayi bangun. 
            Sistem akan menganalisis video secara otomatis setiap 15 detik.
          </p>
        </div>
      </div>
    </div>
  );
}
