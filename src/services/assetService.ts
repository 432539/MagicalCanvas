/**
 * assetService.ts
 * 
 * Service for managing assets (images/videos) via the backend API.
 */

const API_BASE_URL = '/api';

/**
 * Uploads a base64 data URL to the server and returns the file path URL.
 * 
 * @param dataUrl The base64 data URL to upload
 * @param type 'image' | 'video'
 * @param prompt Optional prompt associated with the asset
 * @returns Promise resolving to the server-side URL (e.g., /library/images/xyz.png)
 */
export const uploadAsset = async (
    dataUrl: string,
    type: 'image' | 'video' = 'image',
    prompt: string = ''
): Promise<string> => {
    try {
        // If it's already a server URL (not base64), return it as is
        if (!dataUrl.startsWith('data:')) {
            return dataUrl;
        }

        const endpoint = type === 'image' ? `${API_BASE_URL}/assets/images` : `${API_BASE_URL}/assets/videos`;

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                data: dataUrl,
                prompt: prompt
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to upload asset');
        }

        const result = await response.json();
        return result.url;
    } catch (error) {
        console.error('Asset upload failed:', error);
        throw error;
    }
};
