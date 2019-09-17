const io = window.io;
const $ = window.$;
const Cookies = window.Cookies;

class Chat {
    constructor(type) {
        var self = this;
        self.socket = null;
        self.socketUrl = 'https://dev1.antillia.io:8890';
        self.stream = 0;
        self.lastStream = null;
        self.finished = 0;
        self.rejected = 0;
        self.user = 0;
        self.recording = false;
        self.consultant = {id: null, name: null, publisherId: null};
        self.guest = {id: null, name: null, publisherId: null};
        self.pageType = type ? type : 'guest';
        self.checkInterval = null;
        self.video = true;
        self.audio = true;
        self.iceServers = null;
        self.offerOptions = {
            offerToReceiveAudio: 1,
            offerToReceiveVideo: 1,
            voiceActivityDetection: false
        };
        self.constraintsPresenter = {
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            },
            video: true
        };
        self.audioPlayer = null;
        /*
        self.connection = null;
        self.connectionJanus = null;
        self.inCandidates = [];
        self.outCandidates = [];
        self.answerReceived = false;
        */
        self.connection = {};
        self.inCandidates = {};
        self.outCandidates = {};
        self.answerReceived = false;

        // Initialize interface
        self.init();
        self.connect();
    }

    /**
    * Initialize user account
    */
    initUser() {
        var self = this;
        // Am I guest?
        if (self.pageType == 'guest') {
            // If cookie exists — restore stream, else — create a new one
            var stream = Cookies.get('stream');
            var guest = Cookies.get('guest');
            console.log('got stream : ', stream, '\nguest : ', guest);
            if (stream) {
                var data = {stream: stream, guest: guest};
                self.socket.emit('/v1/stream/restore', data);
            } else {
                var data = {guest: guest};
                self.socket.emit('/v1/stream/init', data);
            }
        // Am I consultant?
        } else if (self.pageType == 'consultant') {
            var сonsultant = Cookies.get('consultant');
            var token = Cookies.get('consultantToken');
            if (сonsultant && token && сonsultant != 'null' && token != 'null') {
                self.loginConsultant(сonsultant, token);
            }
        }
    }

    /**
    * Update interface according to actual state
    */
    updateInterface() {
        var self = this;
        // Hide all elements
        $('.screen .in > div').hide();
        if (self.pageType == 'guest') {
            if (self.finished) {
                $('.finished').show()
            } else if (self.rejected) {
                $('.rejected').show()
            } else if (!self.answered) {
                $('.hello').show();
            } else {
                //$('.video').show();
            }
        } else if (self.pageType == 'consultant') {
            if (self.stream) {
                $('.hello').show();
                //$('.video').show();
            } else if (self.consultant.id) {
                $('.hello .name').html(self.consultant.name);
                $('.hello').show();
            } else {
                $('.login').show();
            }
        }
    }

    /**
    * Logout
    *
    */
    logout() {
        Cookies.remove('consultant');
        Cookies.remove('consultantName');
        Cookies.remove('consultantToken');
        Cookies.remove('stream');
        Cookies.remove('guest');
        document.location.href = document.location.href;
    }

    /**
    * Prepare RTCPeerConnection and all related stuff
    *
    * @param callback   function
    */
    prepareConnection(what, callback) {
        var self = this;
        // If answer is received — used for incoming ICE cache
        self.answerReceived = false;
        self.finished = false;
        // Cache of candidates
        self.inCandidates[what] = [];
        self.outCandidates[what] = [];
        // Create connection
        self.connection[what] = new RTCPeerConnection({iceServers:self.iceServers});
        console.log('Created local peer connection');
        self.connection[what].onicecandidate = e => self.onLocalCandidate(what, e);
        self.connection[what].ontrack = e => {
            console.log(e);
            $('#video').get(0).srcObject = e.streams[0];
        }
        self.connection[what].onconnectionstatechange = e => {
            console.log('SSSSSSSSSSSSSSSSS' + what, self.connection[what].connectionState);
        }
        self.connection[what].oniceconnectionstatechange  = e => {
            console.log('IIIIIIIIIIIIIIIIII' + what, self.connection[what].iceConnectionState);
        }
        console.log('Requesting local stream');
        // Request for permissions
        if (what == 'local') {
            navigator.mediaDevices.getUserMedia(self.constraintsPresenter)
                .then(function(stream) {
                    self.localStream = stream;
                    // Toggle audio/video
                    self.localStream.getTracks().forEach(track => {
                        if (track.kind == 'audio' && !self.audio) {
                            track.enabled = false;
                        }
                        if (track.kind == 'video' && !self.video) {
                            track.enabled = false;
                        }
                        self.connection['local'].addTrack(track, self.localStream)
                    });
                    if (self.audio) {
                        $('.audioButton').removeClass('fa-microphone')
                                         .addClass('fa-microphone-slash');
                     } else {
                         $('.audioButton').removeClass('fa-microphone-slash')
                                          .addClass('fa-microphone');
                    }
                    if (self.video) {
                        $('.videoButton').removeClass('fa-video')
                                         .addClass('fa-video-slash');
                     } else {
                         $('.videoButton').removeClass('fa-video-slash')
                                          .addClass('fa-video');
                    }
                    console.log('Adding Local Stream to peer connection');
                    callback();
                })
                .catch(e => {
                    alert(`getUserMedia() error: ${e.name}`);
                    console.log(e);
                });
        } else {
            callback();
        }
    }

    /**
    * Consultant: get next user from queue and send him sdpOffer
    *
    */
    getNext() {
        var self = this;
        if (!self.answered) {
            self.socket.emit('/v1/stream/next');
        }
        // ... and in interval too
        if (self.checkInterval) {
            clearInterval(self.checkInterval);
        }
        self.checkInterval = setInterval(() => {
            if (!self.answered) {
                self.socket.emit('/v1/stream/next');
            }
        }, 1000);
    }

    /**
    * Accept incoming call
    *
    */
    acceptCall(recording) {
        var self = this;
        self.recording = recording;
        self.answered = true;
        self.audioPlayer.volume = 0;
        self.audioPlayer.muted = true;
        $('incoming').hide();
        $('video').show();
        self.prepareConnection('local', err => {
            if (!self.connection['local']) {
                return false;
            }
            self.connection['local'].createOffer(self.offerOptions)
                .then(desc => {
                    // Append offer to connection
                    var message = {type: 'offer', 'sdp': desc.sdp};
                    var sdpOffer = new RTCSessionDescription(message);
                    self.connection['local'].setLocalDescription(sdpOffer)
                        .then(desc => {
                            console.log('Local offer added');
                            // Send request to server
                            var data = {stream: self.stream, sdpOffer: sdpOffer.sdp, video: self.video, audio: self.audio, recording: !!recording};
                            self.socket.emit('/v1/stream/accept', data);
                            // Append local video stream to video tag
                            $('#selfie').get(0).srcObject = self.localStream;
                        }, error => {
                            console.log(error);
                        });
                }, error => {
                    console.log(error);
                });
        });
    }

    /**
    * Reject incoming call
    *
    */
    rejectCall() {
        var self = this;
        self.answered = false;
        self.audioPlayer.volume = 0;
        self.audioPlayer.muted = true;
        $('incoming').hide();
        // Send request to server
        var data = {stream: self.stream};
        self.socket.emit('/v1/stream/reject', data);
    }

    /**
    * Start call for guest
    *
    * @param data   array   Data, received from server
    */
    callStartGuest(data) {
        var self = this;

        self.answered = true;
        self.stream = data.stream;
        self.consultant = data.consultant;
        $('.video h5').html('Call #' + data.stream + ', consultant: ' + data.consultant.name + ' (#' + data.consultant.id + ')');
        console.log('Call started: consultant ' + data.consultant.name);
        $('.thankYou').hide();
        $('#starrr').show();

        // Prepare connection
        self.prepareConnection('local', err => {
            // Append self video to video tag
            $('#selfie').get(0).srcObject = self.localStream;
            // Classic p2p mode
            self.recording = !!data.recording;
            if (!data.recording) {
                // Append offer to connection
                var message = {type: 'offer', 'sdp': data.sdpOffer};
                var sdpOffer = new RTCSessionDescription(message);
                self.connection['local'].setRemoteDescription(sdpOffer)
                    .then(() => {
                        // Create answer...
                        self.connection['local'].createAnswer()
                            .then(sdpAnswer => {
                                self.connection['local'].setLocalDescription(sdpAnswer)
                                    .then(xxx => {
                                        $('.video').show();
                                        $('.footer').hide();
                                        self.answerReceived = true;
                                        // And send answer to consultant
                                        var data = {'stream': self.stream, 'sdpAnswer': sdpAnswer.sdp};
                                        self.socket.emit('/v1/sdp/answer', data);
                                        // Send cached ice candidates too
                                        for (let i in self.inCandidates['local']) {
                                            var candidate = new RTCIceCandidate(self.inCandidates['local'][i]);
                                            self.connection['local'].addIceCandidate(candidate);
                                        }
                                        console.log(self.outCandidates);
                                    }).catch(e => {
                                        console.log(e);
                                    });
                            }).catch(e => {
                                console.log(e);
                            });
                    }).catch(e => {
                        console.log(e);
                    });
            // Recording enabled
            } else {
                self.connection['local'].createOffer(self.offerOptions)
                    .then(desc => {
                        // Append offer to connection
                        var message = {type: 'offer', 'sdp': desc.sdp};
                        var sdpOffer = new RTCSessionDescription(message);
                        self.connection['local'].setLocalDescription(sdpOffer)
                            .then(desc => {
                                console.log('Local offer added');
                                // Send request to server
                                var data = {stream: self.stream, sdpOffer: sdpOffer.sdp, video: self.video, audio: self.audio, recording: self.recording};
                                self.socket.emit('/v1/stream/acceptGuest', data);
                                // Append local video stream to video tag
                                $('#selfie').get(0).srcObject = self.localStream;
                            }, error => {
                                console.log(error);
                            });
                    }, error => {
                        console.log(error);
                    });
            }
        });
    }

    /**
    * Start call for guest in media stream mode — receive sdpAnswer from media server
    *
    * @param data   array   Data, received from server
    */
    callAcceptGuest(data) {
        var self = this;
        // Append answer to connection
        var message = {type: 'answer', 'sdp': data.sdpAnswer};
        var sdpAnswer = new RTCSessionDescription(message);
        self.connection['local'].setRemoteDescription(sdpAnswer)
            .then(() => {
                $('.video').show();
                $('.footer').hide();
                self.answerReceived = true;
            }).catch(e => {
                console.log(e);
            });
    }

    /**
    * Start call as consultant
    *
    * @param data   array   Data, received from server
    */
    callStartConsultant(data) {
        var self = this;
        self.answered = true;
        self.stream = data.stream;
        self.guest = data.guest;
        $('.video h5').html('Call #' + data.stream + ', visitor: #' + data.guest.id);
        self.updateInterface();
        console.log('Call started: visitor ' + data.guest.id);
        // Append answer to connection
        var message = {type: 'answer', 'sdp': data.sdpAnswer};
        var sdpAnswer = new RTCSessionDescription(message);
        self.connection['local'].setRemoteDescription(sdpAnswer)
            .then(() => {
                $('.video').show();
                $('.footer').hide();
                self.answerReceived = true;
                // Send cached candidates
                for (let i in self.outCandidates['local']) {
                    var toSend = {stream: self.stream, message: self.outCandidates['local'][i]};
                    self.socket.emit('/v1/sdp/ice', toSend);
                }
                // Append cached ICE candidates
                for (let i in self.inCandidates['local']) {
                    var candidate = new RTCIceCandidate(self.inCandidates['local'][i]);
                    self.connection['local'].addIceCandidate(candidate);
                }
            }).catch(e => {
                console.log(e);
            });
    }

    /**
    * Request to finish a call
    *
    */
    finishCall() {
        var self = this;
        var data = {stream: self.stream};
        self.socket.emit('/v1/stream/finish', data);
    }

    /**
    * Finish actual callpageType
    *
    * @param data   array   Data, received from server
    */
    onCallFinish(isReject) {
        var self = this;

        self.answered = false;
        self.inCandidates = {};
        self.outCandidates = {};
        self.lastStream = self.stream;
        self.stream = null;
        self.finished = (!isReject);
        self.rejected = (isReject == 1);

        // Close socket to avoid socket reconnects
        if (self.pageType == 'guest') {
            self.socket.close();
        }

        // Close connection
        if (self.localStream) {
            var tracks = self.localStream.getTracks();
            for (let i in tracks) {
                tracks[i].stop();
            }
        }
        if (self.connection['local']) {
            self.connection['local'].close();
        }
        if (self.connection['remote']) {
            self.connection['remote'].close();
        }
        self.localStream = null;

        // Disable video
        $('.video').hide();
        $('.footer').show();
        $('#video').get(0).srcObject = null;
        $('#selfie').get(0).srcObject = null;
        //$('.toWork').show();
        //$('.toRest').hide();
        if (self.pageType == 'consultant') {
            self.getNext();
        }
        self.updateInterface();
    }

    /**
    * Call was accepted by another user
    *
    * @param data   array   Data, received from server
    */
    onCallAcceptedByCollegue(response) {
        var self = this;
        if (self.stream != response.stream) {
            return false;
        }
        self.stream = null;
        self.audioPlayer.muted = true;
        self.audioPlayer.volume = 0;
        $('.incoming').hide();
        $('.veil').hide();
        self.getNext();
    }


    /**
    * User did not wait the answer
    *
    * @param data   array   Data, received from server
    */
    onNotWait(response) {
        var self = this;
        if (self.stream != response.stream) {
            return false;
        }
        self.stream = null;
        self.audioPlayer.muted = true;
        self.audioPlayer.volume = 0;
        $('.incoming').hide();
        $('.veil').hide();
        self.getNext();
    }

    /**
    * Call was interrupted
    *
    * @param data   array   Data, received from server
    */
    onCallInterrupt(data) {
        var self = this;
        if (self.stream) {
            $('.interrupted').show();
        }
    }

    onCallInterruptFinished(data) {
        var self = this;
        if (self.finished || self.stream != data.stream) {
            return false;
        }
        data.guest = self.guest;
        data.consultant = self.consultant;
        $('.interrupted').hide();
        if (self.pageType == 'guest') {
            //self.callStartGuest(data);
        } else {
            //self.callStartConsultant(data);
            self.acceptCall(self.recording);
        }
    }

    /**
    * Local candidate generated
    *
    * @param event   object   Event data
    */
    onLocalCandidate(what, event) {
        var self = this;
        if (event.candidate) {
            console.log('Local candidate', event.candidate);
            // Append it to connecion if both offer and answer was appended
            // Recording enabled
            if (self.recording) {
                if (self.pageType == 'guest') {
                    var data = {stream: self.stream, message: event.candidate, publisherId: self.consultant.publisherId};
                } else {
                    var data = {stream: self.stream, message: event.candidate, publisherId: self.guest.publisherId};
                }
                console.log('LLLLLLLLLLLLLLLLLLLL', data);
                self.socket.emit('/v1/sdp/ice', data);
            // P2p, answer received
            } else if (self.answerReceived) {
                var data = {stream: self.stream, message: event.candidate};
                self.socket.emit('/v1/sdp/ice', data);
            // ... or cache it
            } else {
                self.outCandidates[what].push(event.candidate);
            }
        }
    }

    /**
    * Remote candidate received
    *
    * @param data   array   Data, received from server
    */
    onRemoteCandidate(data) {
        var self = this;
        console.log('Remote candidate', data);
        // Append it to connecion if both offer and answer was appended
        if (self.answerReceived) {
            var candidate = new RTCIceCandidate(data.message);
            self.connection['local'].addIceCandidate(candidate)
        // ... or cache it
        } else {
            if (!self.inCandidates['local']) {
                self.inCandidates['local'] = [];
            }
            self.inCandidates['local'].push(data.message);
        }
    }

    /**
    * Ask to toggle video or audio
    *
    * @param video   bool   Is video enabled
    * @param audio   bool   Is audio enabled
    */
    changeMedia(video, audio) {
        var self = this;
        self.video = video;
        self.audio = audio;
        // If stream is established — send request to server
        if (self.stream) {
            var data = {stream: self.stream, video: video, audio: audio};
            self.socket.emit('/v1/stream/media', data);
            self.localStream.getAudioTracks()[0].enabled = audio;
            self.localStream.getVideoTracks()[0].enabled = video;
        }
    }

    /**
    * Media server mode: publisher list changed
    *
    * @param data   array   Data, received from server
    */
    onChangePublishers(data) {
        var self = this;
        var watchPublisher = false;
        console.log(self.consultant);
        console.log(data.publishers.consultant);
        if (self.pageType == 'guest' &&
            self.consultant &&
            data.publishers.consultant &&
            self.consultant.publisherId != data.publishers.consultant.publisherId) {
                self.consultant.publisherId = data.publishers.consultant.publisherId;
                watchPublisher = data.publishers.consultant.publisherId;
        } else if (self.pageType == 'consultant' &&
                   self.guest &&
                   data.publishers.guest &&
                   self.guest.publisherId != data.publishers.guest.publisherId) {
            self.guest.publisherId = data.publishers.guest.publisherId;
            watchPublisher = data.publishers.guest.publisherId;
        }
        if (!watchPublisher) {
            return false;
        }
        let request = {stream: self.stream,
                       //sdpAnswer: sdpAnswer.sdp,
                       publisherId: watchPublisher};
                       console.log('GGGGGGGGGGGGGGGGGGGGGGG', request);
        self.socket.emit('/v1/publisher/watch', request);
    }

    watchPublisher(data) {
        let self = this;
        console.log('RRRRR 0', data);
        if (!data.sdpOffer) {
            return false;
        }
        self.prepareConnection('remote', err => {
            let message = {type: 'offer', 'sdp': data.sdpOffer};
            let sdpOffer = new RTCSessionDescription(message);
            console.log(data);
            self.connection['remote'].setRemoteDescription(sdpOffer)
                .then(() => {
                    console.log('RRRRR 1');
                    // Create answer...
                    self.connection['remote'].createAnswer()
                        .then(sdpAnswer => {
                            self.connection['remote'].setLocalDescription(sdpAnswer)
                                .then(xxx => {
                                    console.log('RRRRR 2');
                                    // And send answer to consultant
                                    var request = {stream: self.stream,
                                                   sdpAnswer: sdpAnswer.sdp,
                                                   publisherId: data.publisherId};
                                    console.log('MMMMMMMMMMMMMMMMMM', request);
                                    self.socket.emit('/v1/sdp/answer', request);
                                }).catch(e => {console.error(e);});
                        }).catch(e => {console.error(e);});
                }).catch(e => {console.error(e);});
        });
    }

    /**
    * Socket connection
    *
    */
    connect() {
        var self = this;
        if (self.socket) {
            return false;
        }
        // Connection and Hello
        self.socket = new io(self.socketUrl, {secure: true});

        // Additional alive requiests
        setInterval(fake => {
            if (self.finished && self.pageType == 'guest') {
                return false;
            }
            self.socket.emit('/v1/alive');
        }, 1000);

        self.socket.on('connect', () => {
            self.updateInterface();
            self.logItSocket('Socket connected', new Date());
        });

        self.socket.on('connect_error', (error) => {
            self.logItSocket('connection error', error);
            if (self.finished && self.pageType == 'guest') {
                return false;
            }
            self.socket.close();
            self.socket = null;
            setTimeout(() => {
                self.connect();
            }, 1000);
        });

        self.socket.on('disconnect', (error) => {
            self.logItSocket('Disconnected', error);
            if (self.finished && self.pageType == 'guest') {
                return false;
            }
            setTimeout(() => {
                self.connect();
            }, 1000);
        });

        // Ready, steady, go...
        self.socket.on('/v1/ready', function (response) {
            // Restore existing chat session for guest
            self.socket.emit('/v1/schedule/list');
            if (self.pageType == 'guest') {
                self.socket.emit('/v1/schedule/online');
            } else {
                self.initUser(response);
            }
            self.iceServers = response.iceServers;
        });

        // If somebody is online
        self.socket.on('/v1/schedule/online', function (response) {
            // Restore existing chat session for guest
            if (self.pageType == 'guest') {
                if (!response.online) {
                    $ ('.closed').show();
                    /*
                    $ ('.closed .when').html('');
                    $ ('.footer .schedule').clone().appendTo($ ('.closed .when'));
                    */
                    $ ('.hello').hide();
                } else {
                    self.initUser(response);
                }
            }
        });

        // Logged in
        self.socket.on('/v1/user/login', function (response) {
            if (response.code != 200) {
                console.log(response);
               if (!response.tokenAuth) {
                   //alert(response.message);
               }
               return false;
            }
            self.consultant.id = response.consultant.id;
            self.consultant.name = response.consultant.name;
            Cookies.set('consultant', self.consultant.id, {path: '/', expires: 365});
            Cookies.set('consultantName', self.consultant.name, {path: '/', expires: 365});
            Cookies.set('consultantToken', response.consultant.token, {path: '/', expires: 365});
            self.updateInterface();
            self.logItSocket('/v1/user/login', response);
        });

        // Stream Initialized
        self.socket.on('/v1/stream/init', function (response) {
            self.guest = response.guest;
            self.stream = response.stream;
            Cookies.set('stream', self.stream, {path: '/'});
            Cookies.set('guest', self.guest, {path: '/'});
            self.updateInterface();
            self.logItSocket('/v1/stream/init', response);
        });

        // Chat restored - for guest
        self.socket.on('/v1/stream/restore', function (response) {
            self.stream = response.stream;
            self.updateInterface(response);
            self.logItSocket('/v1/stream/restore', response);
        });

        // Incoming call
        self.socket.on('/v1/stream/incoming', function (response) {
            console.log('Vistor found, ready for a call');
            clearInterval(self.checkInterval);
            //self.answered = true;
            self.stream = response.stream;
            self.audioPlayer.volume = 1;
            self.audioPlayer.muted = false;
            setTimeout(() => {
                self.audioPlayer.muted = true;
                self.audioPlayer.volume = 0;
            }, 10000);
            $('.incoming').show();
            $('.veil').show();
            self.logItSocket('/v1/stream/incoming', response);
        });

        // Request to start a call
        self.socket.on('/v1/stream/accept', function (response) {
            self.logItSocket('/v1/stream/accept', response);
        });

        // Call start for guest user in a media server mode
        self.socket.on('/v1/stream/acceptGuest', function (response) {
            self.callAcceptGuest(response);
            self.logItSocket('/v1/stream/acceptGuest', response);
        });

        // Incoming stream accepted by collutor
        self.socket.on('/v1/stream/accepted', function (response) {
            self.callStartGuest(response);
            self.logItSocket('/v1/stream/accepted', response);
        });

        // Call was accepted by another consultant
        self.socket.on('/v1/stream/acceptedByCollegue', function (response) {
            self.onCallAcceptedByCollegue(response);
            self.logItSocket('/v1/stream/acceptedByCollegue', response);
        });

        // User did not wait for answer
        self.socket.on('/v1/stream/notWait', function (response) {
            self.onNotWait(response);
            self.logItSocket('/v1/stream/notWait', response);
        });

        // You rejected a call
        self.socket.on('/v1/stream/reject', function (response) {
            self.onCallFinish();
            self.logItSocket('/v1/stream/reject', response);
        });

        // Call was rejected by consultant
        self.socket.on('/v1/stream/rejected', function (response) {
            self.onCallFinish(1);
            self.logItSocket('/v1/stream/rejected', response);
        });

        // Call was interrupted
        self.socket.on('/v1/stream/interrupt', function (response) {
            self.onCallInterrupt();
            self.logItSocket('/v1/stream/interrupt', response);
        });

        // Call was continued
        self.socket.on('/v1/stream/interruptFinished', function (response) {
            self.onCallInterruptFinished(response);
            self.logItSocket('/v1/stream/interruptFinished', response);
        });

        // Call was finished
        self.socket.on('/v1/stream/finish', function (response) {
            self.onCallFinish();
            self.logItSocket('/v1/stream/finish', response);
        });

        // Update publisher list for media-server based calls
        self.socket.on('/v1/stream/publishers', function (response) {
            self.onChangePublishers(response);
            self.logItSocket('/v1/stream/publishers', response);
        });

        // Watch publisher
        self.socket.on('/v1/publisher/watch', function (response) {
            self.watchPublisher(response);
            self.logItSocket('/v1/publisher/watch', response);
        });

        // Update number of pending users for consultant
        self.socket.on('/v1/stream/pending', function (response) {
            if (self.pageType == 'consultant') {
                $('.pending').html(response.pending-0);
                self.logItSocket('/v1/stream/pending', response);
            }
        });

        // Update number of pending users for visitors
        self.socket.on('/v1/stream/inFront', function (response) {
            if (response.consultants > 0) {
                $('.pending').html(response.pending-0);
                $('.inFront').html(response.inFront-0);
                $('.headerPending').show();
                $('.headerNobody').hide();
            } else {
                $('.headerPending').hide();
                $('.headerNobody').show();
            }
            self.logItSocket('/v1/stream/inFront', response);
        });

        // Show schedule
        self.socket.on('/v1/schedule/list', function (response) {
            $('.footer .schedule table tr').remove();
            for (let i in response.list) {
                var tr = $('<tr></tr>');
                var weekday = ["","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday", "Sunday"][response.list[i].day];
                var from = response.list[i].from && response.list[i].from != '00:00:00' ? response.list[i].from.substr(0,5) : '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
                var till = response.list[i].till && response.list[i].till != '00:00:00' ? response.list[i].till.substr(0,5) : '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
                var td = $('<td></td>').html(weekday + ':').appendTo(tr);
                if (from || till) {
                    var td = $('<td></td>').html(from + ' - ' + till).appendTo(tr);
                } else {
                    var td = $('<td></td>').html('—').addClass('center').appendTo(tr);
                }
                $('.schedule table').append(tr);
            }
            self.logItSocket('/v1/schedule/list', response);
        });

        // Collutor's media changed — video/audio was enabled/disabled
        self.socket.on('/v1/stream/peer_media', function (response) {
            self.logItSocket('/v1/stream/peer_media', response);
        });

        // Incoming sdpAnswer
        self.socket.on('/v1/sdp/peer_answer', function (response) {
            self.callStartConsultant(response);
            self.logItSocket('/v1/call/peer_answer', response);
        });

        // Incoming ICE candidate
        self.socket.on('/v1/sdp/peer_ice', function (response) {
            self.onRemoteCandidate(response);
            self.logItSocket('/v1/call/peer_ice', response);
        });

        // General error
        self.socket.on('/v1/error', function (response) {
            self.logItSocket('/v1/call/error', response);
        });
    }

    /**
    * Initialize user interface
    *
    */
    init() {
        var self = this;
        self.audioPlayer = new Audio();
        self.audioPlayer.src = "/call.mp3";
        self.audioPlayer.volume = 0;
        self.audioPlayer.muted = true;
        self.audioPlayer.loop = true;
        document.body.appendChild(self.audioPlayer);

        // Insterface elements
        $(document).ready(function() {
            // Consultant: login form
            $('.login .submit').on('click', function() {
                self.login();
            });
            // Consultant: logout
            $('.exit').on('click', function() {
                self.logout();
            });
            // Consultant: ask for the next call
            $('.toWork').on('click', function() {
                self.getNext();
                self.muted = true;
                self.audioPlayer.play();
                $('.toWork').hide();
                $('.toRest').show();
            });
            // Consultant: do not wait for next call
            $('.toRest').on('click', function() {
                clearInterval(self.checkInterval);
                //self.audioPlayer.pause();
                $('.toWork').show();
                $('.toRest').hide();
            });
            // Consultant: accept incoming call
            $('.accept').on('click', function() {
                self.acceptCall();
            });
            // Consultant: accept incoming call
            $('.record').on('click', function() {
                self.acceptCall(true);
            });
            // Consultant: reject incoming call
            $('.reject').on('click', function() {
                self.rejectCall();
            });
            // Finish actual call
            $('.finishButton').on('click', function() {
                self.finishCall();
            });
            // Toggle audio
            $('.audioButton').on('click', () => {
                if ($('.audioButton').hasClass('fa-microphone-slash')) {
                   self.changeMedia(self.video, 0);
                   $('.audioButton').addClass('fa-microphone')
                              .removeClass('fa-microphone-slash');
                } else {
                   self.changeMedia(self.video, 1);
                   $('.audioButton').removeClass('fa-microphone')
                              .addClass('fa-microphone-slash');
                }
            });
            // Toggle video
            $('.videoButton').on('click', () => {
                if ($('.videoButton').hasClass('fa-video-slash')) {
                   self.changeMedia(0, self.audio);
                   $('.videoButton').addClass('fa-video')
                              .removeClass('fa-video-slash');
                } else {
                   self.changeMedia(1, self.audio);
                   $('.videoButton').removeClass('fa-video')
                              .addClass('fa-video-slash');
                }
            });

            if (typeof $('#starrr').starrr != 'undefined') {
                $('#starrr').starrr({
                    change: function(e, value){
                        var data = {stream: self.lastStream, rate: value};
                        self.socket.emit('/v1/stream/rate', data);
                        $('.thankYou').show();
                        $('#starrr').hide();
                    }
                });
            }

            // Connection to socket
            console.log("Initialization complete");
        });
    }

    /**
    * Log incoming data
    *
    * @param command   string   Socket event
    * @param data      array    Received data
    */
    logItSocket(command, data) {
        console.log(command, data);
    }
}

export default Chat;
