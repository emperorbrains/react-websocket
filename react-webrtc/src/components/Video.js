import React from 'react';
import Chat from '../utils/Chat';

class Video extends React.Component {

    componentDidMount() {
        let chat;
        console.log('window location : ', window.location);
        const isConsultant = window.location.href.includes('consultant');
        if(isConsultant) {
            chat = new Chat('consultant');
        }
        else {
            chat = new Chat();
        }
        chat.initUser();
        console.log('got chat : ', chat);
    }

    render() {
        return (
            <div className="video hide">
                <h5></h5>
                <video id="video" autoplay playsinline></video>
                <video id="selfie" autoplay muted playsinline></video>
                <div className="buttons clear">
                    <i className="fas fa-phone-slash disabled finishButton"></i>
                    <i className="fas fa-microphone-slash audioButton"></i>
                    <i className="fas fa-video-slash videoButton"></i>
                    &nbsp;&nbsp;
                </div>
            </div>
        )
    }
}

export default Video;