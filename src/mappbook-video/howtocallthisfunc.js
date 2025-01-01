// app/api/lambda-server/route.ts
import { NextResponse } from 'next/server';

type RequestData = {
  points: any[]; // Replace with your specific points type
  aspectRatio: string;
  mappbook_user_id: string;
  show_labels: boolean;
  animation_video_id: string;
};

// You might want to move this to an environment variable
const LAMBDA_ENDPOINT = 'https://gedsq7ntux2i46oscwjviyrvjq0pyubc.lambda-url.us-east-1.on.aws/33333333';

export async function POST(request: Request) {
  try {
    // Parse the request body
    const body = await request.json() as RequestData;
    const { mappbook_user_id, animation_video_id } = body;

    console.log(body)

    // Validate required fields
    if (!mappbook_user_id || !animation_video_id) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Make request to Lambda
    const lambdaResponse = await fetch(LAMBDA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mappbook_user_id,
        animation_video_id,
      }),
    });

    if (!lambdaResponse.ok) {
      throw new Error(`Lambda returned ${lambdaResponse.status}`);
    }

    const data = await lambdaResponse.json();

    return NextResponse.json({
      success: true,
      data,
    });

  } catch (error) {
    console.error('Lambda server error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// If you need to handle other HTTP methods, you can add them like this:
export async function GET() {
  return NextResponse.json(
    { success: false, error: 'Method not allowed' },
    { status: 405 }
  );
}

// For the config options in App Router, create a separate config file
// app/api/lambda-server/config.ts
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};