"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Page() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("idle");

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidate[]>([]);
  const roomIdRef = useRef<string | null>(null);
  const connectionKeyRef = useRef<string | null>(null);
  const usernameRef = useRef("user-" + crypto.randomUUID());

  const username = usernameRef.current;

  const attachLocalVideo = useCallback((video: HTMLVideoElement | null) => {
    localVideoRef.current = video;

    if (video && localStreamRef.current && video.srcObject !== localStreamRef.current) {
      video.srcObject = localStreamRef.current;
    }
  }, []);

  const attachRemoteVideo = useCallback((video: HTMLVideoElement | null) => {
    remoteVideoRef.current = video;

    if (video && remoteStreamRef.current && video.srcObject !== remoteStreamRef.current) {
      video.srcObject = remoteStreamRef.current;
    }
  }, []);

  const startCamera = async () => {
    if (localStreamRef.current) return localStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localStreamRef.current = stream;

    if (localVideoRef.current && localVideoRef.current.srcObject !== stream) {
      localVideoRef.current.srcObject = stream;
    }

    return stream;
  };

  const resetConnection = () => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
    remoteStreamRef.current = null;
    connectionKeyRef.current = null;
    setStatus("idle");

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const leaveRoom = async () => {
    const currentRoomId = roomIdRef.current;
    if (!currentRoomId) return;

    await supabase
      .from("participants")
      .delete()
      .eq("room_id", currentRoomId)
      .eq("username", username);

    roomIdRef.current = null;
    setRoomId(null);
    setParticipants([]);
    resetConnection();
  };

  useEffect(() => {
    const handlePageHide = () => {
      const currentRoomId = roomIdRef.current;
      if (!currentRoomId) return;

      supabase
        .from("participants")
        .delete()
        .eq("room_id", currentRoomId)
        .eq("username", username)
        .then(() => {});
    };

    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      peerRef.current?.close();
    };
  }, [username]);

  useEffect(() => {
    if (!roomId) return;

    roomIdRef.current = roomId;

    const fetchParticipants = async () => {
      const { data, error } = await supabase
        .from("participants")
        .select("*")
        .eq("room_id", roomId);

      if (error) {
        console.warn("Participants error:", error.message);
        return;
      }

      setParticipants(data ?? []);
    };

    fetchParticipants();

    const channel = supabase
      .channel("room-" + roomId)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "participants",
          filter: `room_id=eq.${roomId}`,
        },
        fetchParticipants
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId || participants.length !== 2 || !localStreamRef.current) return;

    const users = participants.map((p) => p.username).sort();
    const connectionKey = `${roomId}:${users.join(":")}`;

    if (connectionKeyRef.current === connectionKey) return;

    connectionKeyRef.current = connectionKey;

    let cancelled = false;

    peerRef.current?.close();
    pendingCandidatesRef.current = [];
    remoteStreamRef.current = null;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
    });

    const remoteStream = new MediaStream();

    peerRef.current = pc;
    remoteStreamRef.current = remoteStream;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }

    const flushPendingCandidates = async () => {
      for (const candidate of pendingCandidatesRef.current) {
        await pc.addIceCandidate(candidate);
      }

      pendingCandidatesRef.current = [];
    };

    localStreamRef.current.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current as MediaStream);
    });

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((t) => t.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      } else {
        remoteStream.addTrack(event.track);
      }

      if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
    };

    pc.onconnectionstatechange = () => {
      setStatus(pc.connectionState);
    };

    pc.onicecandidate = async (event) => {
      if (!event.candidate || cancelled || pc.signalingState === "closed") return;

      const { error } = await supabase.from("signals").insert([
        {
          room_id: roomId,
          sender: username,
          type: "candidate",
          candidate: event.candidate.toJSON(),
        },
      ]);

      if (error) console.warn("Candidate insert error:", error.message);
    };

    const isCaller = users[0] === username;

    const handleSignal = async (signal: any) => {
      if (cancelled || pc.signalingState === "closed") return;
      if (signal.sender === username) return;

      if (signal.type === "candidate" && signal.candidate) {
        const candidate = new RTCIceCandidate(signal.candidate);

        if (pc.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          pendingCandidatesRef.current.push(candidate);
        }

        return;
      }

      if (signal.type === "offer") {
        if (pc.signalingState !== "stable") return;

        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushPendingCandidates();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const { error } = await supabase.from("signals").insert([
          {
            room_id: roomId,
            sender: username,
            type: "answer",
            sdp: answer,
          },
        ]);

        if (error) console.warn("Answer insert error:", error.message);
        return;
      }

      if (signal.type === "answer") {
        if (pc.signalingState !== "have-local-offer") return;

        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushPendingCandidates();
      }
    };

    const channel = supabase
      .channel("signals-" + roomId)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "signals",
          filter: `room_id=eq.${roomId}`,
        },
        async (payload) => {
          try {
            await handleSignal(payload.new);
          } catch (err) {
            console.warn("Signal handling error:", err);
          }
        }
      )
      .subscribe(async (subscribeStatus) => {
        try {
          if (subscribeStatus !== "SUBSCRIBED") return;

          const { data, error } = await supabase
            .from("signals")
            .select("*")
            .eq("room_id", roomId);

          if (error) {
            console.warn("Existing signals fetch error:", error.message);
            return;
          }

          for (const signal of data ?? []) {
            await handleSignal(signal);
          }

          if (!isCaller) return;
          if (cancelled || pc.signalingState === "closed") return;

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const { error: offerError } = await supabase.from("signals").insert([
            {
              room_id: roomId,
              sender: username,
              type: "offer",
              sdp: offer,
            },
          ]);

          if (offerError) console.warn("Offer insert error:", offerError.message);
        } catch (err) {
          console.warn("Subscribe/signaling error:", err);
        }
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);

      if (pc.signalingState !== "closed") {
        pc.close();
      }

      if (peerRef.current === pc) {
        peerRef.current = null;
      }
    };
  }, [roomId, participants.length, username]);

  const start = async () => {
    if (loading) return;
    setLoading(true);

    try {
      await startCamera();
      await leaveRoom();

      const { data: waitingParticipants, error: waitingError } = await supabase
        .from("participants")
        .select("room_id")
        .limit(100);

      if (waitingError) {
        console.warn("Matchmaking error:", waitingError.message);
        setLoading(false);
        return;
      }

      const counts: Record<string, number> = {};

      (waitingParticipants ?? []).forEach((p) => {
        counts[p.room_id] = (counts[p.room_id] || 0) + 1;
      });

      let roomToJoin: string | null = null;

      for (const candidateRoomId of Object.keys(counts)) {
        if (counts[candidateRoomId] === 1) {
          roomToJoin = candidateRoomId;
          break;
        }
      }

      if (!roomToJoin) {
        const { data, error } = await supabase
          .from("rooms")
          .insert([{}])
          .select()
          .single();

        if (error || !data) {
          console.warn("Room create error:", error?.message);
          setLoading(false);
          return;
        }

        roomToJoin = data.id;
      }

      const { error: insertError } = await supabase.from("participants").insert([
        {
          room_id: roomToJoin,
          username,
        },
      ]);

      if (insertError) {
        console.warn("Participant insert error:", insertError.message);
        setLoading(false);
        return;
      }

      roomIdRef.current = roomToJoin;
      setRoomId(roomToJoin);
    } catch (err) {
      console.warn("Start error:", err);
    }

    setLoading(false);
  };

  const next = async () => {
    if (loading) return;
    setLoading(true);

    try {
      await leaveRoom();

      const { data, error } = await supabase
        .from("rooms")
        .insert([{}])
        .select()
        .single();

      if (error || !data) {
        console.warn("Next room error:", error?.message);
        setLoading(false);
        return;
      }

      const { error: insertError } = await supabase.from("participants").insert([
        {
          room_id: data.id,
          username,
        },
      ]);

      if (insertError) {
        console.warn("Next participant insert error:", insertError.message);
        setLoading(false);
        return;
      }

      roomIdRef.current = data.id;
      setRoomId(data.id);
    } catch (err) {
      console.warn("Next error:", err);
    }

    setLoading(false);
  };

  if (!roomId) {
    return (
      <div style={{ background: "black", color: "white", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20 }}>
        <h1 style={{ fontSize: 32 }}>Groupspeak</h1>
        <button onClick={start} disabled={loading} style={{ padding: "10px 20px", background: "white", color: "black", borderRadius: 8, opacity: loading ? 0.5 : 1, cursor: loading ? "not-allowed" : "pointer" }}>
          {loading ? "Starting..." : "Start"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ background: "black", color: "white", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ textAlign: "center", padding: 10, opacity: 0.8 }}>
        {participants.length < 2 ? `Waiting for someone... (${participants.length}/2)` : `Connected: ${status}`}
      </div>

      <div style={{ textAlign: "center", marginBottom: 10 }}>
        <button onClick={next} disabled={loading} style={{ padding: "8px 18px", background: "white", color: "black", borderRadius: 8, opacity: loading ? 0.5 : 1, cursor: loading ? "not-allowed" : "pointer" }}>
          {loading ? "Switching..." : "Next"}
        </button>
      </div>

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: 10 }}>
        <video ref={attachLocalVideo} autoPlay muted playsInline style={{ width: "100%", height: "100%", background: "#000", borderRadius: 16, objectFit: "cover" }} />
        <video ref={attachRemoteVideo} autoPlay muted playsInline style={{ width: "100%", height: "100%", background: "#000", borderRadius: 16, objectFit: "cover" }} />
      </div>
    </div>
  );
}
