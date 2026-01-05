/**
 * Cloudflare bypass via Nemu Agent
 * 
 * Uses the agent's /solve-cf endpoint to open a WebView for user to solve.
 * Agent handles cookie storage automatically.
 */

export interface AgentCfResult {
  solved: boolean;
  windowId?: string;
}

/**
 * Solve Cloudflare challenge via Nemu Agent
 * 
 * @param agentUrl - Agent base URL (e.g., "http://localhost:19283")
 * @param url - URL that triggered the CF challenge
 * @param timeout - Max time to wait for solution (default: 120s)
 */
export async function solveViaAgent(
  agentUrl: string,
  url: string,
  timeout: number = 120000
): Promise<boolean> {
  console.log(`[Agent CF] Starting challenge for: ${url}`);
  
  try {
    // Start the challenge - agent will open WebView
    const startRes = await fetch(`${agentUrl}/solve-cf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    
    if (!startRes.ok) {
      console.error(`[Agent CF] Failed to start: ${startRes.status}`);
      return false;
    }
    
    const { window_id } = await startRes.json() as { window_id: string };
    console.log(`[Agent CF] WebView opened (${window_id}), waiting for user to solve...`);
    
    // Poll for result
    const pollInterval = 1000;
    const maxAttempts = Math.ceil(timeout / pollInterval);
    
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval));
      
      try {
        const statusRes = await fetch(`${agentUrl}/solve-cf/${window_id}`);
        if (!statusRes.ok) {
          console.error(`[Agent CF] Status check failed: ${statusRes.status}`);
          continue;
        }
        
        const { status } = await statusRes.json() as { status: string };
        
        if (status === "solved") {
          console.log(`[Agent CF] Challenge solved!`);
          return true;
        }
        
        if (status === "failed" || status === "cancelled") {
          console.log(`[Agent CF] Challenge ${status}`);
          return false;
        }
        
        // Still pending, continue polling
      } catch (e) {
        // Agent might have crashed
        console.error(`[Agent CF] Poll error:`, e);
      }
    }
    
    console.log(`[Agent CF] Timeout waiting for solution`);
    return false;
  } catch (e) {
    console.error(`[Agent CF] Error:`, e);
    return false;
  }
}

