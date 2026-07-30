// contrib/routes/issue-97-device-pairing-suite/handlers.ts

// Simulated in-memory databases
const pairings = new Map<string, { status: 'pending' | 'approved' }>();
const sessions = new Map<string, { deviceId: string; status: 'active' | 'revoked' }>();

export const requestHandler = (req: { deviceId: string }, res: any) => {
    pairings.set(req.deviceId, { status: 'pending' });
    return res.json({ message: "Device pairing requested", deviceId: req.deviceId });
};

export const approveHandler = (req: { deviceId: string }, res: any) => {
    const record = pairings.get(req.deviceId);
    if (!record) {
        return res.status(404).json({ error: "No pending pairing request found for this device" });
    }

    pairings.set(req.deviceId, { status: 'approved' });
    return res.json({ message: "Device pairing approved", deviceId: req.deviceId });
};

export const issueSessionHandler = (req: { deviceId: string }, res: any) => {
    const record = pairings.get(req.deviceId);
    
    if (!record) {
        return res.status(404).json({ error: "No pairing record found" });
    }
    if (record.status !== 'approved') {
        return res.status(403).json({ error: "Device pairing has not been approved" });
    }

    // Generate a simulated session token
    const sessionId = `sess_${Math.random().toString(36).substring(2, 15)}`;
    sessions.set(sessionId, { deviceId: req.deviceId, status: 'active' });
    
    return res.json({ message: "Session issued successfully", sessionId });
};

export const revokeHandler = (req: { sessionId: string }, res: any) => {
    const session = sessions.get(req.sessionId);
    if (!session) {
        return res.status(404).json({ error: "Session not found" });
    }

    sessions.set(req.sessionId, { ...session, status: 'revoked' });
    return res.json({ message: "Session successfully revoked", sessionId: req.sessionId });
};

export const statusHandler = (req: { sessionId: string }, res: any) => {
    const session = sessions.get(req.sessionId);
    if (!session) {
        return res.status(404).json({ error: "Session not found" });
    }

    return res.json({ message: "Session status retrieved", status: session.status });
};
