const database = new Map<string, { expiresAt: number; status: 'pending' | 'granted' }>();

export const requestHandler = (req: { origin: string }, res: any) => {
    database.set(req.origin, { expiresAt: 0, status: 'pending' });
    return res.json({ message: "Permission requested successfully", origin: req.origin });
};

export const grantHandler = (
    req: { origin: string; expirySeconds: number }, 
    res: any, 
    simulatedTimeMs: number = Date.now()
) => {
    const record = database.get(req.origin);
    if (!record) {
        return res.status(404).json({ error: "No pending request found for this origin" });
    }

    const expiresAt = simulatedTimeMs + (req.expirySeconds * 1000);
    database.set(req.origin, { expiresAt, status: 'granted' });
    
    return res.json({ message: "Permission granted", expiresAt });
};

export const checkHandler = (
    req: { origin: string }, 
    res: any, 

    simulatedTimeMs: number = Date.now()
) => {
    const record = database.get(req.origin);
    
    if (!record) {
        
        return res.status(404).json({ error: "No record found" });
    }
    if (record.status !== 'granted') {

        return res.status(403).json({ error: "Permission has not been granted" });
    }

    if (simulatedTimeMs > record.expiresAt) {
        return res.status(403).json({ 
            error: "Permission has expired", 
            expired: true 
        });
    }

    return res.json({ 
        message: "Permission is active", 
        expired: false 
    });
};
