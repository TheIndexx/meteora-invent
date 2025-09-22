/**
 * Standardized JSON response utilities for Python integration
 */

/**
 * Create success response
 */
export function createSuccessResponse(data = {}) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...data
  };
}

/**
 * Create error response
 */
export function createErrorResponse(error, details = {}) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  return {
    success: false,
    error: errorMessage,
    timestamp: new Date().toISOString(),
    ...details
  };
}

/**
 * Output JSON response and exit
 */
export function outputResponse(response) {
  console.log(JSON.stringify(response, null, 2));
  process.exit(response.success ? 0 : 1);
}

/**
 * Handle async function execution with proper error handling
 */
export async function executeWithErrorHandling(asyncFn) {
  try {
    const result = await asyncFn();
    outputResponse(createSuccessResponse(result));
  } catch (error) {
    console.error('Script error:', error);
    outputResponse(createErrorResponse(error, {
      stack: error.stack,
      name: error.name
    }));
  }
}