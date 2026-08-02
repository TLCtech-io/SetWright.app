// POST /auth/signout -> end the session and return to the login page. A route (not a
// server action) so the AuthBar's plain form works without client JS.

import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
    const supabase = await serverClient();
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login", request.url), {
        status: 303,
    });
}
